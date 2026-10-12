use std::collections::VecDeque;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant as StdInstant};

use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use data_encoding::BASE64;
use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::{tcp, udp};
use smoltcp::time::Instant;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr, IpEndpoint, Ipv4Address};

const MTU: usize = 1380;

struct QueueDevice {
    rx: VecDeque<Vec<u8>>,
    tx: VecDeque<Vec<u8>>,
}

struct QueueRx(Vec<u8>);
struct QueueTx<'a>(&'a mut VecDeque<Vec<u8>>);

impl RxToken for QueueRx {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}

impl TxToken for QueueTx<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut buffer = vec![0u8; len];
        let result = f(&mut buffer);
        self.0.push_back(buffer);
        result
    }
}

impl Device for QueueDevice {
    type RxToken<'a>
        = QueueRx
    where
        Self: 'a;
    type TxToken<'a>
        = QueueTx<'a>
    where
        Self: 'a;

    fn receive(&mut self, _: Instant) -> Option<(QueueRx, QueueTx<'_>)> {
        let packet = self.rx.pop_front()?;
        Some((QueueRx(packet), QueueTx(&mut self.tx)))
    }

    fn transmit(&mut self, _: Instant) -> Option<QueueTx<'_>> {
        Some(QueueTx(&mut self.tx))
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ip;
        caps.max_transmission_unit = MTU;
        caps
    }
}

pub struct ClientConfig {
    pub private_key: [u8; 32],
    pub address: Ipv4Addr,
    pub dns: Ipv4Addr,
    pub server_public: [u8; 32],
    pub endpoint: SocketAddr,
}

fn decode32(text: &str) -> [u8; 32] {
    BASE64
        .decode(text.trim().as_bytes())
        .expect("base64 key")
        .try_into()
        .expect("32 byte key")
}

/// Reads the wg-quick text the sidecar returns in `peer-added`.
pub fn parse_config(text: &str) -> ClientConfig {
    let mut values = std::collections::HashMap::new();
    for line in text.lines() {
        if let Some((key, value)) = line.split_once('=') {
            values.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    let get = |key: &str| values.get(key).unwrap_or_else(|| panic!("config has no {key}"));
    ClientConfig {
        private_key: decode32(get("PrivateKey")),
        address: get("Address").split('/').next().unwrap().parse().unwrap(),
        dns: get("DNS").parse().unwrap(),
        server_public: decode32(get("PublicKey")),
        endpoint: get("Endpoint").parse().unwrap(),
    }
}

pub struct WgClient {
    pub config: ClientConfig,
    socket: UdpSocket,
    tunn: Tunn,
    iface: Interface,
    device: QueueDevice,
    sockets: SocketSet<'static>,
    started: StdInstant,
    next_port: u16,
    buf: Vec<u8>,
}

impl WgClient {
    pub fn connect(config_text: &str) -> Result<WgClient, String> {
        Self::connect_with(parse_config(config_text))
    }

    pub fn connect_with(config: ClientConfig) -> Result<WgClient, String> {
        let socket = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        socket.connect(config.endpoint).map_err(|e| e.to_string())?;
        socket
            .set_read_timeout(Some(Duration::from_millis(5)))
            .map_err(|e| e.to_string())?;
        let tunn = Tunn::new(
            StaticSecret::from(config.private_key),
            PublicKey::from(config.server_public),
            None,
            Some(25),
            7,
            None,
        );
        let mut device = QueueDevice {
            rx: VecDeque::new(),
            tx: VecDeque::new(),
        };
        let mut iface_config = Config::new(HardwareAddress::Ip);
        iface_config.random_seed = 0x5eed;
        let mut iface = Interface::new(iface_config, &mut device, Instant::now());
        iface.update_ip_addrs(|addrs| {
            addrs
                .push(IpCidr::new(IpAddress::Ipv4(config.address), 24))
                .ok();
        });
        iface
            .routes_mut()
            .add_default_ipv4_route(Ipv4Address::new(10, 73, 0, 1))
            .ok();
        let mut client = WgClient {
            config,
            socket,
            tunn,
            iface,
            device,
            sockets: SocketSet::new(Vec::new()),
            started: StdInstant::now(),
            next_port: 40000,
            buf: vec![0u8; 65535],
        };
        client.handshake()?;
        Ok(client)
    }

    fn send_datagram(&self, datagram: &[u8]) {
        let _ = self.socket.send(datagram);
    }

    fn handshake(&mut self) -> Result<(), String> {
        let deadline = StdInstant::now() + Duration::from_secs(5);
        let mut last_try = StdInstant::now() - Duration::from_secs(10);
        while StdInstant::now() < deadline {
            if self.tunn.time_since_last_handshake().is_some() {
                return Ok(());
            }
            if last_try.elapsed() > Duration::from_millis(700) {
                last_try = StdInstant::now();
                if let TunnResult::WriteToNetwork(init) =
                    self.tunn.format_handshake_initiation(&mut self.buf, false)
                {
                    let init = init.to_vec();
                    self.send_datagram(&init);
                }
            }
            self.pump();
        }
        Err("no WireGuard handshake within 5 s".into())
    }

    fn now(&self) -> Instant {
        Instant::from_millis(self.started.elapsed().as_millis() as i64)
    }

    /// One round: receive a datagram, run the stack, send what the stack produced.
    pub fn pump(&mut self) {
        let mut datagram = vec![0u8; 65535];
        if let Ok(len) = self.socket.recv(&mut datagram) {
            let mut result = self.tunn.decapsulate(None, &datagram[..len], &mut self.buf);
            loop {
                match result {
                    TunnResult::WriteToNetwork(reply) => {
                        let reply = reply.to_vec();
                        let _ = self.socket.send(&reply);
                        result = self.tunn.decapsulate(None, &[], &mut self.buf);
                    }
                    TunnResult::WriteToTunnelV4(plain, _) => {
                        self.device.rx.push_back(plain.to_vec());
                        break;
                    }
                    _ => break,
                }
            }
        }
        let now = self.now();
        self.iface.poll(now, &mut self.device, &mut self.sockets);
        while let Some(packet) = self.device.tx.pop_front() {
            if let TunnResult::WriteToNetwork(sealed) = self.tunn.encapsulate(&packet, &mut self.buf) {
                let sealed = sealed.to_vec();
                self.send_datagram(&sealed);
            }
        }
        if let TunnResult::WriteToNetwork(timer) = self.tunn.update_timers(&mut self.buf) {
            let timer = timer.to_vec();
            self.send_datagram(&timer);
        }
    }

    fn pump_for(&mut self, duration: Duration) {
        let end = StdInstant::now() + duration;
        while StdInstant::now() < end {
            self.pump();
        }
    }

    fn port(&mut self) -> u16 {
        self.next_port += 1;
        self.next_port
    }

    fn open_udp(&mut self) -> SocketHandle {
        let port = self.port();
        let mut socket = udp::Socket::new(
            udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 8], vec![0; 4096]),
            udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 8], vec![0; 4096]),
        );
        socket.bind(port).expect("bind udp");
        self.sockets.add(socket)
    }

    /// Sends one UDP datagram through the tunnel and waits for one answer.
    pub fn udp_exchange(
        &mut self,
        dst: Ipv4Addr,
        port: u16,
        payload: &[u8],
        wait: Duration,
    ) -> Option<Vec<u8>> {
        let handle = self.open_udp();
        self.sockets
            .get_mut::<udp::Socket>(handle)
            .send_slice(payload, IpEndpoint::new(IpAddress::Ipv4(dst), port))
            .expect("udp send");
        let end = StdInstant::now() + wait;
        let mut answer = None;
        while StdInstant::now() < end && answer.is_none() {
            self.pump();
            if let Ok((data, _)) = self.sockets.get_mut::<udp::Socket>(handle).recv() {
                answer = Some(data.to_vec());
            }
        }
        self.sockets.remove(handle);
        answer
    }

    pub fn dns_query_raw(&mut self, name: &str, qtype: u16) -> Option<Vec<u8>> {
        let mut query = vec![0xAB, 0xCD, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        for label in name.split('.') {
            query.push(label.len() as u8);
            query.extend_from_slice(label.as_bytes());
        }
        query.push(0);
        query.extend_from_slice(&qtype.to_be_bytes());
        query.extend_from_slice(&1u16.to_be_bytes());
        let dns = self.config.dns;
        self.udp_exchange(dns, 53, &query, Duration::from_secs(5))
    }

    /// Resolves A records through the tunnel's DNS server.
    pub fn dns_a(&mut self, name: &str) -> Vec<Ipv4Addr> {
        let Some(response) = self.dns_query_raw(name, 1) else {
            return Vec::new();
        };
        parse_a_answers(&response)
    }

    /// Plain HTTP/1.1 GET with `Connection: close`; returns the raw response text.
    pub fn http_get(&mut self, ip: Ipv4Addr, port: u16, host: &str, path: &str) -> Result<String, String> {
        self.http_get_bytes(ip, port, host, path)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Same as `http_get`, but returns the raw bytes (headers and body).
    pub fn http_get_bytes(&mut self, ip: Ipv4Addr, port: u16, host: &str, path: &str) -> Result<Vec<u8>, String> {
        self.http_get_inner(ip, port, host, path, false)
    }

    /// Sends the request, then closes its own sending side (FIN) and still reads the whole answer.
    pub fn http_get_half_closed(&mut self, ip: Ipv4Addr, port: u16, host: &str, path: &str) -> Result<Vec<u8>, String> {
        self.http_get_inner(ip, port, host, path, true)
    }

    fn http_get_inner(&mut self, ip: Ipv4Addr, port: u16, host: &str, path: &str, half_close: bool) -> Result<Vec<u8>, String> {
        let local = self.port();
        let socket = tcp::Socket::new(
            tcp::SocketBuffer::new(vec![0; 65535]),
            tcp::SocketBuffer::new(vec![0; 65535]),
        );
        let handle = self.sockets.add(socket);
        {
            let cx = self.iface.context();
            self.sockets
                .get_mut::<tcp::Socket>(handle)
                .connect(cx, (IpAddress::Ipv4(ip), port), local)
                .map_err(|e| format!("connect: {e:?}"))?;
        }
        let request = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
        let mut sent = false;
        let mut response = Vec::new();
        let deadline = StdInstant::now() + Duration::from_secs(10);
        let outcome = loop {
            if StdInstant::now() > deadline {
                break Err(format!("timeout, got {} bytes", response.len()));
            }
            self.pump();
            let socket = self.sockets.get_mut::<tcp::Socket>(handle);
            if !sent && socket.may_send() {
                socket
                    .send_slice(request.as_bytes())
                    .map_err(|e| format!("send: {e:?}"))?;
                sent = true;
                if half_close {
                    socket.close();
                }
            }
            if socket.can_recv() {
                let _ = socket.recv(|data| {
                    response.extend_from_slice(data);
                    (data.len(), ())
                });
            }
            // The server closes after answering (Connection: close).
            if sent && !socket.may_recv() && !socket.can_recv() {
                break Ok(());
            }
            if socket.state() == tcp::State::Closed && !sent {
                break Err("connection refused or reset before sending".into());
            }
        };
        self.sockets.get_mut::<tcp::Socket>(handle).abort();
        self.pump_for(Duration::from_millis(20));
        self.sockets.remove(handle);
        outcome.map(|_| response)
    }
}

/// Pulls the IPv4 addresses out of a DNS response (answers use a pointer to the name).
pub fn parse_a_answers(response: &[u8]) -> Vec<Ipv4Addr> {
    let mut out = Vec::new();
    if response.len() < 12 {
        return out;
    }
    let answers = u16::from_be_bytes([response[6], response[7]]);
    // Skip the question: header, name, type, class.
    let mut pos = 12;
    while pos < response.len() && response[pos] != 0 {
        pos += usize::from(response[pos]) + 1;
    }
    pos += 1 + 4;
    for _ in 0..answers {
        if pos + 12 > response.len() {
            break;
        }
        pos += 2; // name pointer
        let rtype = u16::from_be_bytes([response[pos], response[pos + 1]]);
        let rdlen = usize::from(u16::from_be_bytes([response[pos + 8], response[pos + 9]]));
        pos += 10;
        if rtype == 1 && rdlen == 4 && pos + 4 <= response.len() {
            out.push(Ipv4Addr::new(
                response[pos],
                response[pos + 1],
                response[pos + 2],
                response[pos + 3],
            ));
        }
        pos += rdlen;
    }
    out
}
