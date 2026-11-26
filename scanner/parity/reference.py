# Python reference implementation of the STRAT core.
# The block between the BEGIN/END markers started as the original design
# reference and has since been extended in LOCKSTEP with the JS core
# (2026-07-06/07: 3-1-2 color routing, 3-2 pivot-ladder/1.5R, 1-2-2, 1-3,
# PMG, MoMo shape; 2026-10-31: served target rules v2 replace the pivot
# ladder and 1.5R). It is the maintained Python MIRROR, not a frozen copy:
# every JS core semantic change MUST land here in the same commit, and an
# UNEXPLAINED discrepancy vs the JS core is a first-class finding, never
# something to paper over on either side.
#
# __main__ plumbing below the block reads a JSON data file written by
# run_parity.js and emits results JSON computed FROM THE SAME BARS
# (this file never fetches anything).

# ---- BEGIN reference implementation ----


def classify(h, l, ph, pl):
    bh, bl = h > ph, l < pl  # strict inequalities
    if bh and bl:
        return "3"
    if bh:
        return "2U"
    if bl:
        return "2D"
    return "1"


def classify_series(closed):
    t = [None] * len(closed)
    for i in range(1, len(closed)):
        t[i] = classify(closed[i]["h"], closed[i]["l"], closed[i - 1]["h"], closed[i - 1]["l"])
    return t


M3 = {
    ("3", "1", "2U"): "3-1-2U",
    ("3", "1", "2D"): "3-1-2D",
    ("2D", "1", "2U"): "2D-1-2U",
    ("2U", "1", "2D"): "2U-1-2D",
    ("2U", "1", "2U"): "2U-1-2U",
    ("2D", "1", "2D"): "2D-1-2D",
    ("3", "2D", "2U"): "3-2D-2U",
    ("3", "2U", "2D"): "3-2U-2D",
}
M2 = {("2D", "2U"): "2D-2U", ("2U", "2D"): "2U-2D", ("3", "2U"): "3-2U", ("3", "2D"): "3-2D"}
# 1-2-2 Rev Strat completed forms (2026-07-06)
M3[("1", "2D", "2U")] = "1-2-2"
M3[("1", "2U", "2D")] = "1-2-2"


def _has(ctx, key):
    # JS truthiness of ctx && ctx[key]: an empty array still counts.
    return ctx is not None and ctx.get(key) is not None


def _has_daily(ctx):
    return _has(ctx, "daily")


def level_target(closed, d, trigger, ctx=None):
    """First prior level not yet taken out, beyond the trigger, on FINISHED
    bars only (served target rules v2, spec section 2; mirror of the JS
    levelTarget). Returns (px, src, i) or None. Equality never takes a level
    out (strict break), hence >= / <=. Search order: the signal timeframe's
    closed bars, then ctx.bridge (finished 1h bars), then ctx.daily, each
    newest first and each only before the oldest instant searched so far."""
    up = d == "up"
    run = [float("-inf") if up else float("inf")]

    def hit(v):
        if (v >= run[0] and v > trigger) if up else (v <= run[0] and v < trigger):
            return True
        run[0] = max(run[0], v) if up else min(run[0], v)
        return False

    for i in range(len(closed) - 1, -1, -1):
        v = closed[i]["h"] if up else closed[i]["l"]
        if hit(v):
            return (v, "tf", i)
    start = closed[0]["t"] if closed else float("inf")
    for src in ("bridge", "daily"):
        if not _has(ctx, src):
            continue
        bars = ctx[src]
        for j in range(len(bars) - 1, -1, -1):
            b = bars[j]
            if b["t"] >= start:
                continue  # only bars that START before what was searched
            v = b["h"] if up else b["l"]
            if hit(v):
                return (v, src, j)
        if src == "bridge" and bars and bars[0]["t"] < start:
            start = bars[0]["t"]
    return None


def resolve_target(closed, d, trigger, bar0, ctx=None):
    """(target, tgt_rule) per spec section 3: a level hit ("structural" when
    it is bar 0 = closed[n-2] and bar0 is set, else "level"); else "none" at
    an all-time extreme of a complete history; else entry +/- 1.5 percent."""
    r = level_target(closed, d, trigger, ctx)
    if r is not None:
        px, src, i = r
        return px, ("structural" if bar0 and src == "tf" and i == len(closed) - 2 else "level")
    if _has_daily(ctx) and ctx.get("complete") is True:
        return None, "none"
    return (trigger * 1.015 if d == "up" else trigger * 0.985), "fallback"


def completed(t):
    n = len(t)
    if n < 2:
        return None
    tL, tP = t[n - 1], t[n - 2]
    tQ = t[n - 3] if n >= 3 else None
    if tQ and (tQ, tP, tL) in M3:
        return M3[(tQ, tP, tL)]
    if tP and (tP, tL) in M2:
        return M2[(tP, tL)]
    return None


def setups(closed, t, ctx=None):
    n = len(closed)
    out = []
    if n < 2:
        return out
    L, P = closed[n - 1], closed[n - 2]
    tL, tP = t[n - 1], t[n - 2]

    def add(name, d, trig, stop, tgt, kind, rule):
        out.append([name, d, trig, stop, tgt, kind, rule])

    # Methodology decision 2026-07-06: a Type 3 reference bar's direction is
    # its close color (green bullish, red bearish); a 3-1-2 in the SAME
    # direction as the 3's color is a CONTINUATION. Dead-even close stays
    # reversal-eligible (the break decides).
    # Continuation and 3-2 targets: served target rules v2 (design decision
    # 2026-10-31) - the first untaken prior level
    # beyond the trigger, else "none" at an all-time extreme of a complete
    # history, else entry +/- 1.5 percent. Mirror of the JS resolve.
    def res(d, trigger, bar0):
        return resolve_target(closed, d, trigger, bar0, ctx)

    p3green = tP == "3" and P["c"] > P["o"]
    p3red = tP == "3" and P["c"] < P["o"]
    if tL == "1":
        if tP == "3":
            if p3green:
                tg, rl = res("up", L["h"], True)
                add("3-1-2U", "up", L["h"], P["l"], tg, "cont", rl)
            else:
                add("3-1-2U", "up", L["h"], P["l"], P["h"], "rev", "structural")
        elif tP == "2D":
            add("2D-1-2U", "up", L["h"], P["l"], P["h"], "rev", "structural")
        elif tP == "2U":
            cs = min(P["l"], L["l"])
            tg, rl = res("up", L["h"], True)
            add("2U-1-2U", "up", L["h"], cs, tg, "cont", rl)
        elif tP == "1":
            add("1-1-2U", "up", L["h"], L["l"], None, "info", "none")
        else:
            add("?-1-2U", "up", L["h"], L["l"], None, "info", "none")
        if tP == "3":
            if p3red:
                tg, rl = res("down", L["l"], True)
                add("3-1-2D", "down", L["l"], P["h"], tg, "cont", rl)
            else:
                add("3-1-2D", "down", L["l"], P["h"], P["l"], "rev", "structural")
        elif tP == "2U":
            add("2U-1-2D", "down", L["l"], P["h"], P["l"], "rev", "structural")
        elif tP == "2D":
            cs2 = max(P["h"], L["h"])
            tg, rl = res("down", L["l"], True)
            add("2D-1-2D", "down", L["l"], cs2, tg, "cont", rl)
        elif tP == "1":
            add("1-1-2D", "down", L["l"], L["h"], None, "info", "none")
        else:
            add("?-1-2D", "down", L["l"], L["h"], None, "info", "none")
    elif tL == "2D":
        if tP == "3":
            add("3-2D-2U", "up", L["h"], min(P["l"], L["l"]), P["h"], "rev", "structural")
        elif tP in ("2U", "2D"):
            add("2D-2U", "up", L["h"], L["l"], P["h"], "rev", "structural")
        elif tP == "1" and n >= 3:
            # 1-2-2 Rev Strat: the 2D is the trap bar; reversal through its
            # high targets bar 0's wick (2026-07-06).
            add("1-2-2", "up", L["h"], L["l"], closed[n - 3]["h"], "rev", "structural")
    elif tL == "2U":
        if tP == "3":
            add("3-2U-2D", "down", L["l"], max(P["h"], L["h"]), P["l"], "rev", "structural")
        elif tP in ("2U", "2D"):
            add("2U-2D", "down", L["l"], L["h"], P["l"], "rev", "structural")
        elif tP == "1" and n >= 3:
            add("1-2-2", "down", L["l"], L["h"], closed[n - 3]["l"], "rev", "structural")
    elif tL == "3":
        # 3-2 has no structural magnitude: resolve with bar0 off, so a hit is
        # always "level" (spec section 1).
        tg, rl = res("up", L["h"], False)
        add("3-2U", "up", L["h"], L["l"], tg, "rev", rl)
        tg, rl = res("down", L["l"], False)
        add("3-2D", "down", L["l"], L["h"], tg, "rev", rl)
    # PMG (Pivot Machine Gun): >= 5 consecutive strictly lower highs (bullish
    # reversal) or higher lows (bearish reversal) ending at the last closed bar.
    # Coexists with the above; emitted regardless of tL EXCEPT a Type-3 last bar
    # (the 3-2 branch owns that). Target = the previous chain rung (pivot ladder),
    # labeled "level". Mirror of the JS core.
    if tL != "3":
        if pmg_run(closed, "lh") >= 5:
            add("PMG", "up", L["h"], L["l"], P["h"], "rev", "level")
        if pmg_run(closed, "hl") >= 5:
            add("PMG", "down", L["l"], L["h"], P["l"], "rev", "level")
    return out


def live(sets, forming):
    # Live rows copy target and tgt_rule from the setup they fired from.
    out = []
    for name, d, trig, stop, tgt, kind, rule in sets:
        hit = forming["h"] > trig if d == "up" else forming["l"] < trig
        if hit and kind != "info":
            out.append([name, d, trig, tgt, rule])
    return out


def week_start(t_ms):  # Monday 00:00 UTC
    dse = t_ms // 86400000
    wd = (dse + 4) % 7  # 0=Sun..6=Sat (epoch day was a Thursday)
    return (dse - ((wd + 6) % 7)) * 86400000


import datetime


def month_start(t_ms):
    d = datetime.datetime.fromtimestamp(t_ms / 1000, datetime.UTC)
    return int(datetime.datetime(d.year, d.month, 1, tzinfo=datetime.UTC).timestamp() * 1000)


def aggregate(days, keyfn):  # days ascending, forming daily may be last
    out = []
    for x in days:
        k = keyfn(x["t"])
        if not out or out[-1]["t"] != k:
            out.append({"t": k, "o": x["o"], "h": x["h"], "l": x["l"], "c": x["c"]})
        else:
            b = out[-1]
            b["h"] = max(b["h"], x["h"])
            b["l"] = min(b["l"], x["l"])
            b["c"] = x["c"]
    if out and days and days[0]["t"] > out[0]["t"]:
        out.pop(0)  # partial first bucket
    return out


def pmg_run(closed, side):
    """PMG run length: consecutive strictly lower highs ("lh") or higher lows
    ("hl") ending at the last closed bar (mirror of the JS pmgRun)."""
    count = 0
    i = len(closed) - 1
    while i >= 1:
        if side == "lh":
            if closed[i]["h"] < closed[i - 1]["h"]:
                count += 1
            else:
                break
        else:
            if closed[i]["l"] > closed[i - 1]["l"]:
                count += 1
            else:
                break
        i -= 1
    return count


MOMO_LEN = 30
MOMO_MIN = 10
MOMO_BODY = 0.30
MOMO_SHADOW = 2.0
MOMO_ERR = 0.25


def momo_shape(closed, forming):
    """MoMo hammer/shooter shape on the last closed bar (mirror of the JS
    momoShape). Display-tier: null | {type, confirming}. avgBody
    includes the signal bar; a zero-body signal floors its body at 1e-12."""
    n = len(closed)
    if n < MOMO_MIN:
        return None
    sig = closed[n - 1]
    lookback = min(MOMO_LEN, n)
    s = 0.0
    for i in range(n - lookback, n):
        s += abs(closed[i]["c"] - closed[i]["o"])
    avg_body = s / lookback
    body = abs(sig["c"] - sig["o"])
    if body > MOMO_BODY * avg_body:
        return None
    body_eff = body if body > 1e-12 else 1e-12
    upper = sig["h"] - max(sig["o"], sig["c"])
    lower = min(sig["o"], sig["c"]) - sig["l"]
    c1, c2, c3 = closed[n - 2]["c"], closed[n - 3]["c"], closed[n - 4]["c"]
    asc = c3 < c2 and c2 < c1
    desc = c3 > c2 and c2 > c1
    typ = None
    if lower > MOMO_SHADOW * body_eff and upper <= MOMO_ERR * avg_body and asc:
        typ = "hammer"
    elif upper > MOMO_SHADOW * body_eff and lower <= MOMO_ERR * avg_body and desc:
        typ = "shooter"
    if typ is None:
        return None
    confirming = False
    if forming is not None:
        confirming = (forming["c"] > sig["h"]) if typ == "hammer" else (forming["c"] < sig["l"])
    return {"type": typ, "confirming": confirming}


# ---- END reference implementation ----


# ---- Harness plumbing only below this line (no detection semantics). ----
import json
import sys


def analyze(closed, forming, first_break=None, ctx=None):
    """Mirror of the JS analyzeTF ORCHESTRATION using only the verbatim
    primitives above. Adds no detection logic of its own.

    first_break mirrors the JS firstBreak param (which side of the last
    closed bar's range the forming bar broke FIRST). The parity harness
    never passes it (the JS side is also called without it), so the 1-3
    Rev Strat below is spec documentation kept in lockstep with the JS
    core rather than a parity-exercised path.

    ctx mirrors the JS ctx param: None or {bridge: [finished 1h bars,
    oldest first], daily: [closed daily bars, oldest first], complete:
    bool} (bridge and daily each optional), read only by the v2 target
    search."""
    res = {
        "types": classify_series(closed),
        "formingType": None,
        "formingDir": None,
        "completed": None,
        "setups": [],
        "live": [],
        "invalidated": False,
        "shape": None,
    }
    n = len(closed)
    if n < 2:
        return res
    L = closed[n - 1]
    P = closed[n - 2]
    if forming:
        res["formingType"] = classify(forming["h"], forming["l"], L["h"], L["l"])
        res["formingDir"] = (
            "up"
            if forming["c"] > forming["o"]
            else ("down" if forming["c"] < forming["o"] else "flat")
        )
    res["completed"] = completed(res["types"])
    res["setups"] = setups(closed, res["types"], ctx)
    if forming:
        res["live"] = live(res["setups"], forming)
        if res["formingType"] == "3" and res["live"]:
            res["invalidated"] = True
        # 1-3 Rev Strat (2026-07-06): inside bar, entry bar takes one
        # side first then the other; second break = reversal entry, target =
        # bar 0's wick (bar 0 = P, the bar before the inside bar). Same
        # [name, dir, entry, target, tgt_rule] shape as live().
        if res["types"][n - 1] == "1" and res["formingType"] == "3":
            if first_break == "down":
                res["live"].append(["1-3", "up", L["h"], P["h"], "structural"])
            elif first_break == "up":
                res["live"].append(["1-3", "down", L["l"], P["l"], "structural"])
    # MoMo hammer/shooter SHAPE on the last closed bar (display-tier mirror).
    res["shape"] = momo_shape(closed, forming)
    return res


def bucket_end_T(t_ms, mode):
    """Inclusive end timestamp of the calendar bucket starting at t_ms,
    matching the JS aggregateBars T field (k + 7d - 1 / nextMonthStart - 1)."""
    if mode == "week":
        return week_start(t_ms) + 604800000 - 1
    d = datetime.datetime.fromtimestamp(t_ms / 1000, datetime.UTC)
    y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return int(datetime.datetime(y, m, 1, tzinfo=datetime.UTC).timestamp() * 1000) - 1


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: python reference.py <data.json> [out.json]\n")
        sys.exit(2)
    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)

    out = {"pairs": [], "agg": []}

    for p in data["pairs"]:
        res = analyze(p["closed"], p["forming"], None, p.get("ctx"))
        out["pairs"].append({"coin": p["coin"], "tf": p["tf"], "py": res})

    for a in data["agg"]:
        mode = a["mode"]
        keyfn = week_start if mode == "week" else month_start
        bars = aggregate(a["dailyInput"], keyfn)
        forming = None
        closed = bars
        if bars and bucket_end_T(bars[-1]["t"], mode) > a["fetchNow"]:
            forming = bars[-1]
            closed = bars[:-1]
        res = analyze(closed, forming, None, a.get("ctx"))
        out["agg"].append(
            {
                "coin": a["coin"],
                "mode": mode,
                "bars": bars,
                "typesAll": classify_series(bars),
                "closedCount": len(closed),
                "hasForming": forming is not None,
                "py": res,
            }
        )

    if len(sys.argv) >= 3:
        with open(sys.argv[2], "w", encoding="utf-8") as f:
            json.dump(out, f)
    else:
        json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
