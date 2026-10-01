//! Mycelium's simulation, compiled to WebAssembly for the game and natively for the tests.
pub mod rng;
pub mod world;
mod ffi;
pub use world::*;
