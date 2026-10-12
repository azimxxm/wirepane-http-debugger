//! A WireGuard client for tests: boringtun for the tunnel and smoltcp as the phone's TCP/IP stack.
//! Blocking and single-threaded on purpose, to keep the tests easy to follow.
#![allow(dead_code)]

pub mod wg_client;
