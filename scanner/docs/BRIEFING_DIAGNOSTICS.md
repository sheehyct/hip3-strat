# Briefing diagnostics runbook

How to read the `/api/briefing/*` routes when a consumer (a scheduled
briefing task, or a person with curl) reports that a briefing looked wrong,
old, missing, or inconsistent. The goal of the machinery documented here is
that the NEXT failure is explainable from the responses and the worker log
alone - not that any particular failure can no longer happen.

What the routes provide for that: snapshot identity, a health endpoint,
serve-time freshness, request ids, structured logs, and a consistency probe.

Examples below use `https://<your-worker-host>`; a local boot is
`http://127.0.0.1:8787`.

## The model

- The worker MATERIALIZES one immutable briefing snapshot per tracked
  universe every 60s (`src/briefing_store.js`, `BRIEFING_INTERVAL_MS` to
  change it) from the same in-memory loop state the routes used to read on
  every request. It reads state only - zero exchange demand, nothing on
  disk, nothing across a restart.
- Every briefing route serves THAT entry until the next tick:
  `latest.html`, `latest.json`, `latest.compact.json`, `latest.csv`, and
  `health`. Within one materialization window they cannot disagree.
- `snapshot_id` = `<boot hex>-<7-digit sequence>`, e.g. `3f9a1c2e-0000412`.
  Opaque. The boot half changes on every restart; the sequence is monotonic
  within a boot. Two responses with the same id were built from the same
  state. Two responses with different ids straddled a materialization and
  MAY legitimately differ - that is not a bug.
- Identity and freshness are different things. `is_stale` and
  `age_seconds` are recomputed at SERVE time from `data_as_of_utc` with the
  current clock, so a stopped producer shows an aging snapshot, never a
  frozen "fresh" label. `generated_at_utc` is the materialization time and
  is therefore identical across representations of one snapshot.

## Endpoints

| Route | Body | Notes |
|---|---|---|
| `GET /api/briefing/health?uni=xyz` | JSON, no rows (~1 KB) | 200 for `ok` and `degraded`, 503 for `unavailable` |
| `GET /api/briefing/latest.html?uni=xyz` | script-free HTML, TSV block | the contract for fetch tools that only read pages |
| `GET /api/briefing/latest.compact.json?uni=xyz` | compact JSON (`row_fields` + array rows) | |
| `GET /api/briefing/latest.json?uni=xyz` | canonical JSON (~250 KB) | |
| `GET /api/briefing/latest.csv?uni=xyz` | 49-column CSV | identity in headers only |
| `HEAD` on any of the above and on `/health` | headers only | |

`?require_complete=1` turns `data_complete=false` into 503. It gates on
completeness (a materialization-time fact), not on serve-time age.

### Health status semantics

| `status` | Meaning | HTTP |
|---|---|---|
| `ok` | a usable snapshot exists, it is complete, its data is younger than 900s, and the producer is healthy | 200 |
| `degraded` | a usable snapshot exists but at least one of: `is_stale`, `data_complete=false`, `producer_status != ok` | 200 |
| `unavailable` | no usable snapshot (no rows - the worker is loading, or the universe has none) | 503 |

`status` is never derived from the process merely answering.

### `producer_status`

| Value | Meaning |
|---|---|
| `ok` | last materialization succeeded within 3 intervals |
| `loading` | the loop has not finished its initial load (`loop_loaded=false`) |
| `error` | the most recent build threw. With an earlier entry, that entry is still served; with NO earlier entry (a failing FIRST build) every route serves an explicit 503 `snapshot_unavailable` document whose `issues` carry `build_failed` and whose first warning carries the error message |
| `idle` | loaded, nothing materialized yet and no build has failed (transient at boot) |
| `stalled` | last materialization older than 3 intervals - the timer is not firing (event loop wedged, or the store was stopped) |

Precedence when several apply: `loading` > `error` > `idle` > `stalled` >
`ok`. Error outranks idle on purpose: a first build that keeps throwing has
no entry, and "idle" would describe a producer that is failing on every
tick.

Every briefing response is built from ONE view (one clock reading, one
snapshot lookup): the headers, the body and the health document of a
single response cannot disagree with each other. Any fault inside the
route is a logged 500 carrying `X-Request-ID` (`[briefing] request
failed`), never a crashed worker.

## Headers

Data headers: `X-Generated-At`, `X-Data-As-Of`, `X-Row-Count`,
`X-Expected-Row-Count`, `X-Universe`, `X-Data-Complete`, `X-Is-Stale`,
`X-Score-Policy`.

Identity headers: `X-Snapshot-ID`, `X-Age-Seconds`, `X-Producer-Status`,
`X-Request-ID`. `Cache-Control` is `no-store, no-cache, must-revalidate`
on every briefing route. All are in `Access-Control-Expose-Headers`.

The same four identity values are rendered in the HTML `<dl>` metadata
(`snapshot_id`, `served_at_utc`, `age_seconds`, `producer_status`) and in
every JSON body, for consumers whose fetch tool hides headers.

`X-Request-ID` echoes an inbound `x-railway-request-id` or `x-request-id`
header (whatever your hosting edge stamps) when it is a plain token;
otherwise a `local-<12 hex>` id is generated. The same id is in the
`[briefing] request` log line for that request.

## Logs

```
[briefing] materializing every 60s (boot 3f9a1c2e)
[briefing] materialized {"reason":"first","snapshot_id":"3f9a1c2e-0000001","universe":"xyz","generated_at_utc":"...","data_as_of_utc":"...","row_count":104,"expected_row_count":104,"missing_symbols":0,"data_complete":true,"issues":[],"warnings":0,"build_ms":31.2,"upstream":{"candle_fetch_failures":0,"mids_fetch_failures":0,"loop_revision":812}}
[briefing] request {"request_id":"7jyq-yY4SemsSt3snPRhug","method":"GET","route":"/api/briefing/latest.html","universe":"xyz","status":200,"snapshot_id":"3f9a1c2e-0000412","ms":3}
[briefing] build failed {"universe":"xyz","at_utc":"...","error":"...","kept_snapshot_id":"...","upstream":{...}}
[briefing] refused regression {"universe":"xyz","kept_snapshot_id":"...","kept_data_as_of_utc":"...","refused_data_as_of_utc":"...","regressions_refused":1}
```

`materialized` lines are throttled: one on the first build, one on every
CHANGE of the diagnostic signature (row/expected counts, completeness,
issues, missing count, warning count), and otherwise at most one per 15
minutes per universe as a heartbeat. `request` lines are unthrottled (low
volume by construction). No secrets, no request bodies, no query strings
beyond `uni`.

## Did the consumer's request reach the origin at all? (edge logs)

Most hosting platforms keep an HTTP record at their edge for EVERY request
that reached it - with the client user agent and source IP - independent of
the app. It is the one source that separates "the consumer never sent it"
from "the origin failed it". The request id in that record is the value the
app echoes as `X-Request-ID`.

What an edge record proves, and what its absence does not: a record exists
only once a TCP connection and TLS handshake have completed and an HTTP
request has been read. NO record therefore means "no HTTP request was
observed at the edge" - which covers a consumer-side tool refusal, a
sandbox with no network, AND a DNS, TCP or TLS failure on the consumer's
path. The edge log cannot tell those apart; consumer-side evidence is what
separates them. An error text that is NOT a DNS error is evidence against
a DNS cause, not proof.

For an LLM scheduled task as the consumer: put every exact URL the task
may open in the task prompt verbatim (the HTML route AND the health route,
each with `?uni=xyz`), use the browsing tool only (a code sandbox usually
has no network), never construct URL variants, and have the task quote any
refusal text verbatim so the failure can be classified.

## Classifying a failure

| Symptom the consumer reports | What to look at | Class |
|---|---|---|
| no HTTP response at all, DNS/TLS/tool error | nothing reached the worker. FIRST check the edge log for the consumer's user agent (section above): no edge record = no HTTP request was observed at the edge, which includes tool refusal, sandbox without network, and consumer-side DNS/TCP/TLS failure - the consumer's own error text is what separates those. `curl -i` from another network | A: consumer / route |
| HTTP 5xx with `X-Request-ID` | find that id in the worker log | A: route |
| `producer_status=stalled` or `error` in health | the store's timer or build - `[briefing] build failed` lines; `/health` `briefing.universes.<uni>` | B: producer stopped |
| `producer_status=ok`, `is_stale=true`, `age_seconds` climbing, same `snapshot_id` data_as_of across ticks | the LOOP is not advancing its stamps: `/health` `midsAgeMs` / `candlesAgeMs` / `contextsAgeMs`, `candleFetchFailures` rising = exchange rate budget or outage | C: upstream |
| `status=degraded`, `issues` contains `contexts_stale_or_missing` only, rows complete | the 60s ctx refresh missed three cycles (429 pressure). Data is USABLE. Field dependency (`src/briefing.js` row builder): the CONTEXT-derived fields are `exchange_24h_reference_price`, `exchange_24h_change_pct`, `exchange_24h_volume_usd`, `funding_hr_pct`, `premium_pct`, `open_interest_usd` - those are the ones a few minutes old. `last`, `utc_session_change_pct`, `overnight_change_pct`, `mom_*`, `rvol_15m`, `atr_14d_pct`, every `*_seq` / `*_change_pct`, `ftfc`, `dwm_continuity_dir`, signals and setups come from mids and candles and are current | C: upstream, minor |
| `data_complete=false`, `missing_symbols` non-empty, `row_count < expected_row_count` | the roster has symbols the loop has no analysis for yet (boot, new listings, a 429'd universe enumeration) | D: partial |
| `status=unavailable` / 503 with `issues: ["worker_loading", "no_rows"]` | the worker is in its initial load (several minutes with both universes tracked). Nothing is served from disk by design | D: boot window |
| the consumer saw an OLDER `data_as_of` after a newer one | compare the two `X-Snapshot-ID` values. Different boot halves = a restart between the fetches (the sequence resets; the data cannot be older within one process, so an older data_as_of after a restart means the loop reloaded - check `/health` `uptime`). Same boot, lower sequence = something between the consumer and the worker replayed a response: quote both `X-Request-ID`s and find them in the log - a replayed response has an id the log shows served EARLIER | F: replay, or restart |
| HTML and JSON disagree | same `snapshot_id`? If different: straddled a materialization, refetch. If the same and the rows differ: a server bug - file it with both request ids | consistency |

## Curl runbook

```
# 1. Is the worker up and what does it think of its snapshot? (~1 KB)
curl -i "https://<your-worker-host>/api/briefing/health?uni=xyz"

# 2. The HTML contract, headers first
curl -i "https://<your-worker-host>/api/briefing/latest.html?uni=xyz"

# 3. Diagnostic mirrors
curl -i "https://<your-worker-host>/api/briefing/latest.compact.json?uni=xyz"
curl -i "https://<your-worker-host>/api/briefing/latest.json?uni=xyz" -o /dev/null -D -
curl -i "https://<your-worker-host>/api/briefing/latest.csv?uni=xyz" -o /dev/null -D -

# 4. Headers only
curl -I "https://<your-worker-host>/api/briefing/latest.html?uni=xyz"

# 5. The worker-level view, including the per-universe briefing block
curl -s "https://<your-worker-host>/health" | node -e "process.stdin.on('data',d=>console.log(JSON.stringify(JSON.parse(d).briefing,null,1)))"
```

## The consistency probe

```
node scripts/briefing_check.js                              # a local boot (127.0.0.1:8787), uni=xyz
node scripts/briefing_check.js https://<your-worker-host>   # a deployed worker
BRIEFING_UNI=perps node scripts/briefing_check.js
```

Fetches all five representations, prints one line per response (status,
header id, body id, data_as_of, age, producer status, rows, request id,
duration, bytes), and exits:

| Exit | Outcome | Meaning |
|---|---|---|
| 0 | `MATCH` | one snapshot id everywhere; every body parsed as a valid document of its format; data_as_of, row counts and symbol sets agree; every body id matches its header |
| 2 | `INCONCLUSIVE` | ids differed across fetches even after 3 rounds - the requests straddled materializations. NOT a consistency bug. The data-level agreement of the last round is still reported |
| 1 | `MISMATCH` | a body did not parse or lacks its format's shape (no symbol column, no snapshot_id, no health status), a body disagrees with its OWN headers, or the same id was served with different data. File it with the request ids |
| 3 | `ERROR` | a request failed; the ids of the responses that did arrive are printed |

Check order: each response is validated on its own first; a
within-response failure is a MISMATCH regardless of the other responses
and is never retried away. Only individually valid responses can be
classified as a straddle.

Run it before and after a deploy.

## What is deliberately not here

- No snapshot on disk, nothing served across a restart. Revisit only if
  the boot window is a material problem for your consumer.
- No parallel `X-HIP3-*` header family: one name per fact.
- No schema change without a version bump: `schema_version=1.0` and
  `format=briefing_compact_v1`; every added field is additive and the CSV
  keeps its 49 columns.
- No multi-replica design: the worker keeps its state in one process and
  one data volume.
