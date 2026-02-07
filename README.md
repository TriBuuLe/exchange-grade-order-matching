# Exchange-Grade Order Book & Matching Engine

## Project Description

This project implements the **core infrastructure of a financial exchange** — the system responsible for accepting orders, maintaining market state, and (eventually) matching trades.

This is **not a trading bot** and **not a toy simulation**.  
It focuses on correctness, determinism, and clean system design, similar to how real stock or crypto exchanges are built internally.

The system is split into three services:

- **Engine (Rust, gRPC)**  
  The headless core of the exchange. It validates orders, assigns deterministic sequence numbers, and maintains in-memory market state (currently top-of-book). It exposes only gRPC APIs and has no HTTP or UI logic.

- **Gateway (Node.js, REST)**  
  A browser-friendly REST service that calls the engine via gRPC. It exists to decouple the UI from the core engine.

- **UI (Next.js)**  
  A browser-based frontend that visualizes market data. It talks only to the gateway and never directly to the engine.

This separation is intentional and mirrors real-world exchange architecture.

Currently, the engine supports:
- order submission with validation
- deterministic sequencing
- in-memory best bid / best ask per symbol
- read API for top-of-book

Future milestones include full order books, matching, trades, persistence, replay, metrics, and containerization.

---

## How to Set Up and Run Locally

### Prerequisites

You must have the following installed:

- Rust (via rustup)
- Node.js (v18+ recommended)
- npm
- protoc (Protocol Buffers compiler)
- grpcurl (for testing the engine)

Verify installations:

```bash
cargo --version
node --version
npm --version
protoc --version
grpcurl -version
```
### Clone the Repository
```bash
git clone https://github.com/TriBuuLe/exchange-grade-order-matching.git
cd exchange-grade-order-matching
```
### Install Dependencies
```bash
cd services/gateway && npm install
cd ../ui && npm install
```

## Run the System (Development)
- This project uses a Makefile so you do not need to manually cd into service directories.
- Open three terminals and run the following commands from the repository root.
### Start the Engine (gRPC – port 50051)
```bash
make engine
```
- You should see: engine listening on 0.0.0.0:50051

### Start the Gateway (REST - port 8080)
```bash
make gateway
```

### Start the UI (Next.js - port 3000)
```bash
make ui
```
- Open your browser: http://localhost:3000


