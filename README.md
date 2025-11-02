# Coinage TypeScript Backend

Stateless Bun service that surfaces SnapTrade crypto trading endpoints for the Java/Spring backend. All requests are authenticated upstream; this service simply validates payloads, sends them to SnapTrade, and relays the results (including `X-Request-ID`) back to callers.

## Prerequisites

- Bun ≥ 1.0 (install from [bun.com/install](https://bun.com/install)).
- SnapTrade partner credentials available as environment variables.

Install dependencies:

```bash
bun install
```

## Environment Variables

| Name                       | Required | Description                                                                 |
|----------------------------|----------|-----------------------------------------------------------------------------|
| `SNAPTRADE_CLIENT_ID`      | ✅       | SnapTrade partner client id                                                |
| `SNAPTRADE_CONSUMER_KEY`   | ✅       | SnapTrade partner consumer key                                             |
| `SNAPTRADE_BASE_URL`       | ❌       | Override SnapTrade API base (defaults to `https://api.snaptrade.com/api/v1`) |
| `COINAGE_TS_SHARED_SECRET` | ❌       | Optional shared secret for future HMAC auth between Java ⇄ TypeScript      |

## Running Locally

```bash
# one-off run
SNAPTRADE_CLIENT_ID=... SNAPTRADE_CONSUMER_KEY=... bun run start

# with live reload
SNAPTRADE_CLIENT_ID=... SNAPTRADE_CONSUMER_KEY=... bun run dev
```

The service listens on `PORT` (defaults to `3000`) and binds to `HOST` (defaults to `0.0.0.0`).

## Tests

Run the Bun-powered unit test suite (mocks SnapTrade SDK calls; no network required):

```bash
bun test
```

## HTTP Surface

All routes expect `accountId`, `userId`, and `userSecret`.

| Method | Path                | Notes                                                                 |
|--------|---------------------|-----------------------------------------------------------------------|
| `GET`  | `/healthz`          | Simple liveness probe                                                |
| `GET`  | `/crypto/pairs`     | Mirrors SnapTrade `searchCryptocurrencyPairInstruments`              |
| `GET`  | `/crypto/quote`     | Mirrors SnapTrade `getCryptocurrencyPairQuote`                       |
| `POST` | `/crypto/preview`   | Mirrors SnapTrade `previewCryptoOrder`                               |
| `POST` | `/crypto/place`     | Mirrors SnapTrade `placeCryptoOrder`; rate limited to 1/sec/account  |

Successful responses include the brokerage payload returned by SnapTrade. For errors we surface the SnapTrade status, payload, and propagate `X-SnapTrade-Request-ID` when available. Order placement is throttled to one request per account per second, returning HTTP `429` when exceeded.

## Deployment Notes

- The Bun process is stateless; scale horizontally without coordination.
- Keep the service on an internal network segment—only your Spring backend should call it.
- Enable shared-secret signing (`COINAGE_TS_SHARED_SECRET`) if you need an extra trust hop between services.

This project was generated from `bun init` and extended to run under Bun’s native `Bun.serve`.
