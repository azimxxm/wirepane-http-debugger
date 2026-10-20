//! The IKEv2 key schedule (RFC 7296 §2.14, §2.15, §2.17) and thin wrappers around `ring` for the
//! primitives: HMAC-SHA-256 as the PRF, AES-GCM (RFC 5282 for IKE, RFC 4106 for ESP), P-256 and
//! X25519 key agreement, SHA-1 for the NAT detection hashes. No primitive is written here.

use ring::aead::{AES_128_GCM, AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::agreement::{self, ECDH_P256, EphemeralPrivateKey, UnparsedPublicKey, X25519};
use ring::digest;
use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};

use super::wire::{DH_CURVE25519, DH_ECP_256};

/// HMAC-SHA-256 output, and the length of SK_d, SK_pi and SK_pr.
pub const PRF_LEN: usize = 32;
/// The salt that follows the AES key in AES-GCM key material (RFC 4106 §8.1, RFC 5282 §7.1).
pub const SALT_LEN: usize = 4;
pub const GCM_IV_LEN: usize = 8;
pub const GCM_ICV_LEN: usize = 16;
const KEY_PAD: &[u8] = b"Key Pad for IKEv2";

/// prf(key, data) with prf = HMAC-SHA-256. `data` is the concatenation of the parts.
pub fn prf(key: &[u8], data: &[&[u8]]) -> [u8; PRF_LEN] {
    let key = hmac::Key::new(hmac::HMAC_SHA256, key);
    let mut context = hmac::Context::with_key(&key);
    for part in data {
        context.update(part);
    }
    let mut out = [0u8; PRF_LEN];
    out.copy_from_slice(context.sign().as_ref());
    out
}

/// prf+ (RFC 7296 §2.13): T1 = prf(K, S | 0x01), Tn = prf(K, Tn-1 | S | n). The counter is one
/// byte, so at most 255 blocks exist; asking for more gives None.
pub fn prf_plus(key: &[u8], seed: &[u8], len: usize) -> Option<Vec<u8>> {
    if len > 255 * PRF_LEN {
        return None;
    }
    let mut out = Vec::with_capacity(len + PRF_LEN);
    let mut previous: Vec<u8> = Vec::new();
    let mut counter = 1u8;
    while out.len() < len {
        let block = prf(key, &[&previous, seed, &[counter]]);
        out.extend_from_slice(&block);
        previous = block.to_vec();
        counter = counter.wrapping_add(1);
    }
    out.truncate(len);
    Some(out)
}

/// An AES-GCM key with its salt. The nonce of every message is salt | 8-byte IV.
pub struct GcmKey {
    key: LessSafeKey,
    salt: [u8; SALT_LEN],
}

impl GcmKey {
    /// `material` is the AES key followed by the 4-byte salt: 20 bytes for AES-128, 36 for AES-256.
    pub fn new(material: &[u8]) -> Option<GcmKey> {
        let algorithm = match material.len() {
            20 => &AES_128_GCM,
            36 => &AES_256_GCM,
            _ => return None,
        };
        let (key, salt) = material.split_at(material.len() - SALT_LEN);
        let unbound = UnboundKey::new(algorithm, key).ok()?;
        let mut salt_bytes = [0u8; SALT_LEN];
        salt_bytes.copy_from_slice(salt);
        Some(GcmKey {
            key: LessSafeKey::new(unbound),
            salt: salt_bytes,
        })
    }

    fn nonce(&self, iv: [u8; GCM_IV_LEN]) -> Nonce {
        let mut nonce = [0u8; 12];
        nonce[..SALT_LEN].copy_from_slice(&self.salt);
        nonce[SALT_LEN..].copy_from_slice(&iv);
        Nonce::assume_unique_for_key(nonce)
    }

    /// Encrypts `in_out` in place and appends the 16-byte ICV.
    pub fn seal(&self, iv: [u8; GCM_IV_LEN], aad: &[u8], in_out: &mut Vec<u8>) -> Option<()> {
        self.key
            .seal_in_place_append_tag(self.nonce(iv), Aad::from(aad), in_out)
            .ok()
    }

    /// Checks the ICV (in constant time, inside ring) and decrypts in place. Returns the plaintext.
    pub fn open<'a>(&self, iv: [u8; GCM_IV_LEN], aad: &[u8], in_out: &'a mut [u8]) -> Option<&'a mut [u8]> {
        if in_out.len() < GCM_ICV_LEN {
            return None;
        }
        self.key.open_in_place(self.nonce(iv), Aad::from(aad), in_out).ok()
    }
}

/// Key lengths in bytes for an ENCR_AES_GCM_16 key length attribute (bits).
pub fn gcm_key_bytes(bits: u16) -> Option<usize> {
    match bits {
        128 => Some(16),
        256 => Some(32),
        _ => None,
    }
}

/// The IKE SA's keys. With AES-GCM there are no SK_ai / SK_ar (RFC 5282).
pub struct IkeKeys {
    pub sk_d: [u8; PRF_LEN],
    pub sk_ei: GcmKey,
    pub sk_er: GcmKey,
    pub sk_pi: [u8; PRF_LEN],
    pub sk_pr: [u8; PRF_LEN],
}

/// The raw key material, split but not yet turned into keys; tests compare it to known values.
pub struct IkeKeyMaterial {
    pub skeyseed: [u8; PRF_LEN],
    pub sk_d: [u8; PRF_LEN],
    pub sk_ei: Vec<u8>,
    pub sk_er: Vec<u8>,
    pub sk_pi: [u8; PRF_LEN],
    pub sk_pr: [u8; PRF_LEN],
}

/// SKEYSEED = prf(Ni | Nr, g^ir); {SK_d | SK_ei | SK_er | SK_pi | SK_pr} = prf+(SKEYSEED, Ni | Nr | SPIi | SPIr).
pub fn ike_key_material(
    ni: &[u8],
    nr: &[u8],
    shared_secret: &[u8],
    spi_i: u64,
    spi_r: u64,
    aes_key_bytes: usize,
) -> Option<IkeKeyMaterial> {
    let nonces = [ni, nr].concat();
    let skeyseed = prf(&nonces, &[shared_secret]);
    let seed = [&nonces[..], &spi_i.to_be_bytes(), &spi_r.to_be_bytes()].concat();
    let encryption = aes_key_bytes + SALT_LEN;
    let material = prf_plus(&skeyseed, &seed, 3 * PRF_LEN + 2 * encryption)?;
    let mut at = 0usize;
    let mut take = |len: usize| {
        let part = material.get(at..at + len).map(<[u8]>::to_vec);
        at += len;
        part
    };
    let sk_d = to_prf_key(&take(PRF_LEN)?)?;
    let sk_ei = take(encryption)?;
    let sk_er = take(encryption)?;
    let sk_pi = to_prf_key(&take(PRF_LEN)?)?;
    let sk_pr = to_prf_key(&take(PRF_LEN)?)?;
    Some(IkeKeyMaterial {
        skeyseed,
        sk_d,
        sk_ei,
        sk_er,
        sk_pi,
        sk_pr,
    })
}

/// Rekeying an IKE SA (RFC 7296 §2.18):
/// SKEYSEED = prf(SK_d (old), g^ir (new) | Ni | Nr)
/// {SK_d | SK_ei | SK_er | SK_pi | SK_pr} = prf+(SKEYSEED, Ni | Nr | SPIi | SPIr)
pub fn ike_rekey_material(
    sk_d_old: &[u8; PRF_LEN],
    ni: &[u8],
    nr: &[u8],
    shared_secret: &[u8],
    spi_i: u64,
    spi_r: u64,
    aes_key_bytes: usize,
) -> Option<IkeKeyMaterial> {
    let seed_data = [shared_secret, ni, nr].concat();
    let skeyseed = prf(sk_d_old, &[&seed_data]);
    let nonces = [ni, nr].concat();
    let seed = [&nonces[..], &spi_i.to_be_bytes(), &spi_r.to_be_bytes()].concat();
    let encryption = aes_key_bytes + SALT_LEN;
    let material = prf_plus(&skeyseed, &seed, 3 * PRF_LEN + 2 * encryption)?;
    let mut at = 0usize;
    let mut take = |len: usize| {
        let part = material.get(at..at + len).map(<[u8]>::to_vec);
        at += len;
        part
    };
    let sk_d = to_prf_key(&take(PRF_LEN)?)?;
    let sk_ei = take(encryption)?;
    let sk_er = take(encryption)?;
    let sk_pi = to_prf_key(&take(PRF_LEN)?)?;
    let sk_pr = to_prf_key(&take(PRF_LEN)?)?;
    Some(IkeKeyMaterial {
        skeyseed,
        sk_d,
        sk_ei,
        sk_er,
        sk_pi,
        sk_pr,
    })
}

fn to_prf_key(bytes: &[u8]) -> Option<[u8; PRF_LEN]> {
    bytes.try_into().ok()
}

impl IkeKeyMaterial {
    pub fn into_keys(self) -> Option<IkeKeys> {
        Some(IkeKeys {
            sk_d: self.sk_d,
            sk_ei: GcmKey::new(&self.sk_ei)?,
            sk_er: GcmKey::new(&self.sk_er)?,
            sk_pi: self.sk_pi,
            sk_pr: self.sk_pr,
        })
    }
}

/// KEYMAT for a Child SA made without a new DH: prf+(SK_d, Ni | Nr). The first half is the
/// initiator-to-responder key + salt, the second the responder-to-initiator one.
pub fn child_key_material(sk_d: &[u8], ni: &[u8], nr: &[u8], aes_key_bytes: usize) -> Option<(Vec<u8>, Vec<u8>)> {
    let each = aes_key_bytes + SALT_LEN;
    let material = prf_plus(sk_d, &[ni, nr].concat(), 2 * each)?;
    let (i_to_r, r_to_i) = material.split_at(each);
    Some((i_to_r.to_vec(), r_to_i.to_vec()))
}

/// The octets AUTH covers (RFC 7296 §2.15): the sender's IKE_SA_INIT message, the other side's
/// nonce, and prf(SK_p, the sender's ID payload body).
pub fn signed_octets(own_init_message: &[u8], peer_nonce: &[u8], sk_p: &[u8], id_body: &[u8]) -> Vec<u8> {
    let maced_id = prf(sk_p, &[id_body]);
    [own_init_message, peer_nonce, &maced_id].concat()
}

/// The PSK form of AUTH: prf(prf(Shared Secret, "Key Pad for IKEv2"), <SignedOctets>).
pub fn psk_auth(psk: &[u8], octets: &[u8]) -> [u8; PRF_LEN] {
    let pad_key = prf(psk, &[KEY_PAD]);
    prf(&pad_key, &[octets])
}

/// Checks a received PSK AUTH value in constant time.
pub fn psk_auth_matches(psk: &[u8], octets: &[u8], received: &[u8]) -> bool {
    let pad_key = prf(psk, &[KEY_PAD]);
    let key = hmac::Key::new(hmac::HMAC_SHA256, &pad_key);
    hmac::verify(&key, octets, received).is_ok()
}

/// NAT detection hash (RFC 7296 §2.23): SHA-1(SPIi | SPIr | IP | port).
pub fn nat_hash(spi_i: u64, spi_r: u64, ip: std::net::IpAddr, port: u16) -> [u8; 20] {
    let mut context = digest::Context::new(&digest::SHA1_FOR_LEGACY_USE_ONLY);
    context.update(&spi_i.to_be_bytes());
    context.update(&spi_r.to_be_bytes());
    match ip {
        std::net::IpAddr::V4(v4) => context.update(&v4.octets()),
        std::net::IpAddr::V6(v6) => context.update(&v6.octets()),
    }
    context.update(&port.to_be_bytes());
    let mut out = [0u8; 20];
    out.copy_from_slice(context.finish().as_ref());
    out
}

pub fn random_bytes(out: &mut [u8]) -> Option<()> {
    SystemRandom::new().fill(out).ok()
}

/// Whether we can do key agreement in this DH group.
pub fn dh_supported(group: u16) -> bool {
    matches!(group, DH_ECP_256 | DH_CURVE25519)
}

/// The length of a KE payload's data for a group (RFC 5903 §7: x | y for P-256; RFC 8031: 32).
pub fn ke_len(group: u16) -> Option<usize> {
    match group {
        DH_ECP_256 => Some(64),
        DH_CURVE25519 => Some(32),
        _ => None,
    }
}

/// Our side of a key exchange: a fresh ephemeral key, our KE data and the shared secret (the x
/// coordinate for P-256 per RFC 5903 §9, the X25519 output per RFC 8031). None when the peer's
/// value is malformed or invalid (ring checks the point is on the curve).
pub fn dh_agree(group: u16, peer_ke: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    let algorithm = match group {
        DH_ECP_256 => &ECDH_P256,
        DH_CURVE25519 => &X25519,
        _ => return None,
    };
    if Some(peer_ke.len()) != ke_len(group) {
        return None;
    }
    let peer = if group == DH_ECP_256 {
        // ring takes the uncompressed SEC1 point; IKEv2 sends x | y without the 0x04 prefix.
        [&[0x04u8][..], peer_ke].concat()
    } else {
        peer_ke.to_vec()
    };
    let private = EphemeralPrivateKey::generate(algorithm, &SystemRandom::new()).ok()?;
    let public = private.compute_public_key().ok()?;
    let ours = if group == DH_ECP_256 {
        public.as_ref().get(1..)?.to_vec()
    } else {
        public.as_ref().to_vec()
    };
    let shared = agreement::agree_ephemeral(private, &UnparsedPublicKey::new(algorithm, &peer), |secret| secret.to_vec()).ok()?;
    // RFC 8031 §2: an all-zero X25519 result means a low-order point; reject it.
    if shared.iter().all(|b| *b == 0) {
        return None;
    }
    Some((ours, shared))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(text: &str) -> Vec<u8> {
        data_encoding::HEXLOWER_PERMISSIVE
            .decode(text.as_bytes())
            .expect("valid hex in the test")
    }

    /// RFC 4231 §4.2 and §4.3: HMAC-SHA-256 test cases 1 and 2.
    #[test]
    fn prf_matches_rfc_4231() {
        assert_eq!(
            prf(&[0x0b; 20], &[b"Hi There"]).to_vec(),
            hex("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7")
        );
        assert_eq!(
            prf(b"Jefe", &[b"what do ya ", b"want for nothing?"]).to_vec(),
            hex("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")
        );
    }

    /// RFC 7296 has no prf+ vectors; these values come from an independent Python implementation of
    /// §2.13 (hmac + hashlib), computed for this test.
    #[test]
    fn prf_plus_matches_an_independent_implementation() {
        assert_eq!(
            prf_plus(b"key", b"seed", 80).expect("short enough"),
            hex("a2392e429a99b173341b368bb5ce320bfd483d89567c14ec187c2d77e3c0a208ba45d21d42611712996c0cd4b329ac8681e093a8a5bbbbf0fb8c9d1cf674f7423fe3d2fbd6641ff544749daa37804f04")
        );
        assert!(prf_plus(b"key", b"seed", 255 * 32 + 1).is_none());
    }

    /// The whole key schedule and the PSK AUTH value, against the same Python implementation.
    #[test]
    fn key_schedule_matches_an_independent_implementation() {
        let ni: Vec<u8> = (0u8..32).collect();
        let nr: Vec<u8> = (32u8..64).collect();
        let material = ike_key_material(&ni, &nr, &[0x42; 32], 0x0102030405060708, 0x1112131415161718, 32)
            .expect("key material");
        assert_eq!(material.skeyseed.to_vec(), hex("5c846fd46a15dc700cf8a27cfc74eaeb9be4081a15c9f02eaf784c37422c8bfa"));
        assert_eq!(material.sk_d.to_vec(), hex("be1665982c095c7e7060cae76e0c394fd57153bcc219d58f27351b4c512814a4"));
        assert_eq!(material.sk_ei, hex("75d580ab16cab59bbcb37d34b17b621b8d3cede1012d92fbc86d2109f8b0bc989a58ce0e"));
        assert_eq!(material.sk_er, hex("d2a7133cca90a24e340a434a559fbcedbd12cec1d8d185fc2e3ed8e9bd2c16342ed115f2"));
        assert_eq!(material.sk_pi.to_vec(), hex("9c8d831152de9a6b580111666e8398760ca00446f9f0ecf4fab79241e4b55aae"));
        assert_eq!(material.sk_pr.to_vec(), hex("90bf8243caf01233c4f76c70e3c09453b5ed622af0b2534cd14ce56e23399faf"));

        let (i_to_r, r_to_i) = child_key_material(&material.sk_d, &ni, &nr, 32).expect("child keys");
        assert_eq!(i_to_r, hex("0af9eb91f6f444049d9f469b16923692a5fb5aba20505893c88aa0c6164b9742bfc7c36c"));
        assert_eq!(r_to_i, hex("159dd722e554ab88fe1666e9f8a77fc2d4c3129d51252df8e9a7060ca522f8c437b69464"));

        let psk = b"0123456789abcdef0123456789abcdef";
        let id_body = [&[2u8, 0, 0, 0][..], b"p1.wirepane"].concat();
        let octets = signed_octets(&[0x99; 100], &nr, &material.sk_pi, &id_body);
        let expected = hex("ce1d4c67445f8b558efa31846662f6ab9ea6ddeb19d6f82e81e06170b74c522e");
        assert_eq!(psk_auth(psk, &octets).to_vec(), expected);
        assert!(psk_auth_matches(psk, &octets, &expected));
        let mut wrong = expected.clone();
        wrong[31] ^= 1;
        assert!(!psk_auth_matches(psk, &octets, &wrong));
        assert!(!psk_auth_matches(psk, &octets, &expected[..31]));
    }

    /// The GCM specification's test case 16 (AES-256, with AAD; McGrew and Viega, also used by
    /// RFC 4106's references). Its 12-byte IV cafebabe facedbaddecaf888 is exactly our salt | IV.
    #[test]
    fn gcm_matches_the_gcm_spec_test_case_16() {
        let key = hex("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308");
        let material = [key, hex("cafebabe")].concat();
        let gcm = GcmKey::new(&material).expect("AES-256 key");
        let iv: [u8; 8] = hex("facedbaddecaf888").try_into().expect("8 bytes");
        let aad = hex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
        let plaintext = hex(
            "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
        );
        let mut buffer = plaintext.clone();
        gcm.seal(iv, &aad, &mut buffer).expect("seals");
        assert_eq!(
            buffer,
            hex("522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f66276fc6ece0f4e1768cddf8853bb2d551b")
        );
        let opened = gcm.open(iv, &aad, &mut buffer).expect("opens").to_vec();
        assert_eq!(opened, plaintext);
    }

    /// The GCM specification's test case 14 (AES-256, zero key, one zero block, no AAD).
    #[test]
    fn gcm_matches_the_gcm_spec_test_case_14() {
        let gcm = GcmKey::new(&[0u8; 36]).expect("AES-256 key");
        let mut buffer = vec![0u8; 16];
        gcm.seal([0; 8], &[], &mut buffer).expect("seals");
        assert_eq!(buffer, hex("cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919"));
    }

    #[test]
    fn gcm_rejects_tampering() {
        let gcm = GcmKey::new(&[7u8; 20]).expect("AES-128 key");
        let mut buffer = b"hello".to_vec();
        gcm.seal([1; 8], b"aad", &mut buffer).expect("seals");
        let mut flipped = buffer.clone();
        flipped[0] ^= 1;
        assert!(gcm.open([1; 8], b"aad", &mut flipped).is_none());
        assert!(gcm.open([1; 8], b"aaD", &mut buffer.clone()).is_none());
        assert!(gcm.open([2; 8], b"aad", &mut buffer.clone()).is_none());
        assert!(gcm.open([1; 8], b"aad", &mut [0u8; 3]).is_none());
        assert!(GcmKey::new(&[0u8; 21]).is_none());
    }

    #[test]
    fn key_agreement_round_trips_in_both_groups() {
        for group in [DH_ECP_256, DH_CURVE25519] {
            let algorithm = if group == DH_ECP_256 { &ECDH_P256 } else { &X25519 };
            let phone = EphemeralPrivateKey::generate(algorithm, &SystemRandom::new()).expect("key");
            let phone_public = phone.compute_public_key().expect("public key");
            let phone_ke = if group == DH_ECP_256 {
                phone_public.as_ref()[1..].to_vec()
            } else {
                phone_public.as_ref().to_vec()
            };
            let (ours, shared) = dh_agree(group, &phone_ke).expect("agreement");
            assert_eq!(Some(ours.len()), ke_len(group));
            let ours_for_ring = if group == DH_ECP_256 { [&[4u8][..], &ours].concat() } else { ours };
            let phone_shared = agreement::agree_ephemeral(phone, &UnparsedPublicKey::new(algorithm, &ours_for_ring), |s| s.to_vec())
                .expect("phone side agrees");
            assert_eq!(shared, phone_shared);
        }
    }

    #[test]
    fn key_agreement_rejects_bad_points() {
        // Wrong lengths, a point that isn't on the curve, and the all-zero X25519 point.
        assert!(dh_agree(DH_ECP_256, &[1; 63]).is_none());
        assert!(dh_agree(DH_ECP_256, &[1; 64]).is_none());
        assert!(dh_agree(DH_CURVE25519, &[0; 32]).is_none());
        assert!(dh_agree(14, &[1; 256]).is_none());
    }
}
