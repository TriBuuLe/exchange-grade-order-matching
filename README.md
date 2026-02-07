# Exchange-Grade Order Book & Matching Engine

## Project Description

This project implements the **core infrastructure of a financial exchange** — the system responsible for accepting orders, maintaining market state, persisting data, and producing deterministic market outputs.

This is **not a trading bot** and **not a toy simulation**.  
It focuses on **correctness, determinism, durability, and clean system design**, similar to how real stock or crypto exchanges are built internally.

The system is split into three services:

- **Engine (Rust, gRPC)**  
  The authoritative core of the exchange. It validates orders, assigns deterministic sequence numbers, maintains a price-time priority order book, performs matching, and persists state.  
  It exposes only gRPC APIs and contains **no HTTP or UI logic**.

- **Gateway (Node.js, REST)**  
  A browser-friendly REST service that calls the engine via gRPC. It decouples the UI from the core engine and exposes market data, order entry, and a trade tape.

- **UI (Next.js)**  
  A browser-based frontend that visualizes live market data. It communicates only with the gateway and never directly with the engine.

This separation is intentional and mirrors real-world exchange architecture where the matching engine is isolated and authoritative.

---

## Current Capabilities

### Engine
- order submission with validation
- deterministic global sequence numbers
- full in-memory price-time priority order book (FIFO per price level)
- order matching with explicit fill records
- write-ahead logging (WAL) for durability
- snapshotting on clean shutdown
- deterministic state recovery on restart (snapshot + WAL replay)
- gRPC APIs for health, order entry, top-of-book, and depth

### Gateway
- REST → gRPC translation layer
- `/orders` for order submission
- `/tob` for top-of-book
- `/depth` for L2 depth
- `/events` trade tape (order accepted + fills)
- `/health` service health checks

### UI
- live top-of-book display
- L2 depth view
- order entry (BUY / SELL)
- fill feedback per submission
- trade tape showing accepted orders and fills
- polling-based updates (WebSockets planned)

---

## How to Set Up and Run Locally

### Prerequisites

You must have the following installed:

- Rust (via rustup)
- Node.js (v18+ recommended)
- npm
- protoc (Protocol Buffers compiler)

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

## Resetting the System (Start from Scratch and remove all existed data)
```bash
rm -f services/engine/engine/data/snapshot.json
rm -f services/engine/engine/data/wal.jsonl
make engine
make gateway
make ui
```


