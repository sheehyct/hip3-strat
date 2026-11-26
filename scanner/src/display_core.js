// GENERATED FILE - DO NOT HAND-EDIT.
// Extracted verbatim from hip3_strat_screener.html (DISPLAY-CORE block)
// by scripts/extract_core.js. The dashboard is the single source of truth.
// Regenerate: npm run extract    Verify (CI anti-drift): npm run extract:check
"use strict";
// ==== DISPLAY-CORE-BEGIN ====
// Display math consumers must mirror EXACTLY. The contract names magProgress and
// the in-force predicate; the rest diverged across surfaces precisely because
// each hand-wrote its own copy.
// Contiguous so scripts/extract_core.js can vendor it like STRAT-CORE.
// Everything here is pure except starSpan, which reads favorites state via
// isFav - vendored as reference semantics, not for standalone execution.
// Context-complete for text nodes AND quoted attributes: the renderers
// interpolate esc() into attribute positions (data-coin, data-star, title),
// so quote escaping is required, not optional (code review, 2026-08-14).
// Exchange coin names are alphanumeric today; this guards the day
// one is not.
function esc(s){
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
                  .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function fmtPx(x){
  if(x === null || x === undefined || !isFinite(x)) return "-";
  var a = Math.abs(x);
  var d = a >= 10000 ? 1 : a >= 1000 ? 2 : a >= 100 ? 2 : a >= 1 ? 3 : 5;
  return x.toLocaleString("en-US",{minimumFractionDigits:0, maximumFractionDigits:d});
}

function chg24(coin){
  if(!coin.ctx) return null;
  var prev = parseFloat(coin.ctx.prevDayPx), px = coin.mid || parseFloat(coin.ctx.markPx);
  if(!prev || !px) return null;
  return (px - prev) / prev * 100;
}

// Per-TF % change: forming close (mid) vs the last CLOSED bar's close on that
// timeframe - the classic "current period change". Null before data lands.
function tfPct(coin, tfId){
  var slot = coin.tf[tfId];
  if(!slot || !slot.closed.length) return null;
  var prev = slot.closed[slot.closed.length - 1].c;
  var px = coin.mid;
  if(!prev || !px || !isFinite(px)) return null;
  return (px/prev - 1)*100;
}

// Magnitude progress: % of the trigger-to-target distance already traveled.
// 0% = at trigger, 100% = at target. The NEGATIVE leg is scaled to the STOP
// distance instead (-100% = at the stop) - "how far toward my stop" is the
// actionable read when price moves against the signal (user decision
// 2026-07-07). Falls back to target-scaled negatives when the stop is
// unusable. Direction-aware; null when there is no target.
function magProgress(sig, mid){
  if(!sig || !mid || !isFinite(mid)) return null;
  var e = (sig.entry !== undefined && sig.entry !== null) ? sig.entry : sig.trigger;
  var t = sig.target;
  if(e === null || e === undefined || t === null || !isFinite(e) || !isFinite(t) || t === e) return null;
  var s = sig.stop;
  var against = sig.dir === "up" ? mid < e : mid > e;
  if(against && s !== null && s !== undefined && isFinite(s) && s !== e){
    return (sig.dir === "up" ? -((e - mid) / (e - s)) : -((mid - e) / (s - e))) * 100;
  }
  var p = sig.dir === "up" ? (mid - e) / (t - e) : (e - mid) / (e - t);
  return p * 100;
}

// Remaining distance to target as a % of CURRENT price - the cross-coin
// comparable "how much move is left" read (design decision 2026-08-16:
// a ranker, not a score change). Positive =
// target still ahead, 0 = at target, negative = beyond it. Direction-aware;
// null without a finite mid and target. Status and in-force gating are the
// CALLER's job: lifecycle status lives outside this block, so this stays
// pure level math like magProgress.
function distToTargetPct(sig, mid){
  if(!sig || !mid || !Number.isFinite(mid)) return null;
  var t = sig.target;
  if(t === null || t === undefined || !Number.isFinite(t)) return null;
  return (sig.dir === "up" ? (t - mid) / mid : (mid - t) / mid) * 100;
}

// Magnitude remaining: the complement of magProgress on its POSITIVE leg -
// % of the trigger-to-target span still untraveled. Null when magProgress
// is null AND on the negative leg: that leg is scaled to the STOP distance,
// so a "130% remaining" would mix units. The intended callers rank IN-FORCE
// signals only (design decision 2026-08-16), and in force implies price beyond entry,
// i.e. the positive leg.
function magRemaining(sig, mid){
  var p = magProgress(sig, mid);
  if(p === null || p < 0) return null;
  return 100 - p;
}

// THE in-force predicate (consumers must mirror this exactly).
// A live signal is "in force" while price still holds beyond the entry level
// during the open bar - a separate predicate from the entry EVENT, which is
// monotonic and cannot untrigger. Unknown inputs (no mid, non-finite entry)
// count as in force: dropping or dimming a signal on missing data would
// overstate what we know. Number.isFinite, NOT the global one: the global
// coerces its argument, so isFinite(null), isFinite("") and isFinite(false)
// are all true and a malformed entry falls through to the comparison - where
// a BEARISH signal evaluates mid < 0 and reports OUT of force, the exact
// opposite of the convention stated above (adversarial review 2026-08-07).
function sigInForce(sig, mid){
  if(!mid || !Number.isFinite(sig.entry)) return true;
  return sig.dir === "up" ? mid > sig.entry : mid < sig.entry;
}

var STAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'+
  ' stroke-linejoin="round"><path d="M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2-5.6-3.2-5.6 3.2'+
  ' 1.3-6.2L3 9.5l6.3-.7z"/></svg>';
function starSpan(name){
  var on = isFav(name);
  // role/tabindex/aria ride here because the span IS the control: deferred
  // from the 2026-08-15 a11y batch to this display_v move, as recorded.
  // The Enter/Space handler lives with the other keyboard wiring outside
  // this block; consumers with native buttons keep aria-pressed semantics.
  return '<span class="star'+(on?' on':'')+'" data-star="'+esc(name)+'" role="button"'+
    ' tabindex="0" aria-pressed="'+(on?'true':'false')+'" aria-label="'+
    (on?'Unpin '+esc(name)+' favorite':'Pin '+esc(name)+' as favorite')+'" title="'+
    (on?'Unpin favorite':'Pin as favorite (stays on top of any sort)')+'">'+STAR_SVG+'</span>';
}

function sigChips(sum, mid, allow){
  var out = [];
  // Optional pattern scoping (design decision 2026-08-16, groundwork for per-column
  // pattern selection): `allow` is a (tf, sig) predicate; absent renders
  // everything, so existing two-argument callers are unchanged. Scoping is
  // applied FIRST - before the dedup ledger and both overflow counts - so
  // no count ever advertises a chip the scope suppressed. The predicate
  // itself (which patterns a user trades) is UI state and stays outside
  // this block; consumers mirror the mechanics, not the taxonomy.
  var live = allow ? sum.live.filter(function(v){ return allow(v.tf, v.sig); }) : sum.live;
  var setupList = allow ? sum.setupList.filter(function(v){ return allow(v.tf, v.sig); }) : sum.setupList;
  // Echo-dedup ledger: EVERY live signal claims its slot up front (not just
  // the four that render), so a fired setup never re-renders as a setup chip
  // below. detailHTML, simpleItems and the domino builder always applied this
  // slot-level dedup; this renderer predated it and was the one consumer
  // without it - 69 duplicate live/setup pairs on production (code review,
  // 2026-08-14). Keys carry dir because 1-2-2 and PMG use one name for both
  // directions.
  var seen = {};
  for(var p=0;p<live.length;p++){
    var lp = live[p];
    seen[lp.tf+"|"+lp.sig.name+"|"+lp.sig.dir] = 1;
  }
  var drawn = {};
  for(var i=0;i<live.length && out.length<4;i++){
    var l = live[i], key = l.tf+"|"+l.sig.name+"|"+l.sig.dir;
    if(drawn[key]) continue; drawn[key] = 1;
    var cls = l.invalidated ? "inval" : (l.sig.dir === "up" ? "live-up" : "live-down");
    var lbl = l.tf+" "+l.sig.name+(l.invalidated ? " INVAL" : (l.sig.kind==="cont" ? " CONT" : " LIVE"));
    // magnitude: % of trigger-to-target distance traveled (bar clamps 0-100, text is exact)
    var magHtml = "", oof = "";
    if(!l.invalidated){
      var mag = magProgress(l.sig, mid);
      if(mag !== null){
        var w = Math.max(0, Math.min(100, mag));
        magHtml = '<span class="mag"><i style="width:'+w.toFixed(0)+'%"></i></span>'+
                  '<span class="magtxt">'+Math.round(mag)+'%</span>';
      }
      // recrossed the entry level -> dimmed (sigInForce is the one predicate)
      if(!sigInForce(l.sig, mid)) oof = " oof";
    }
    out.push('<span class="chip '+cls+oof+'"'+
      (oof ? ' title="entry fired this bar, but price has recrossed the level - signal not currently in force"' : '')+
      '>'+esc(lbl)+magHtml+'</span>');
  }
  if(live.length > 4) out.push('<span class="chip setup">+'+(live.length-4)+'</span>');
  // named per-TF setups (active-TF scoped upstream) instead of an opaque
  // count - echo-filtered FIRST, and the +N overflow counts the FILTERED
  // list, so the count never advertises chips the dedup suppressed.
  var named = [];
  for(var j=0;j<setupList.length;j++){
    var sp = setupList[j];
    if(!seen[sp.tf+"|"+sp.sig.name+"|"+sp.sig.dir]) named.push(sp);
  }
  for(var n=0;n<named.length && n<3;n++)
    out.push('<span class="chip setup">'+esc(named[n].tf+" "+named[n].sig.name)+'</span>');
  if(named.length > 3)
    out.push('<span class="chip setup">+'+(named.length-3)+' setups</span>');
  return out.join("") || '<span class="neu">-</span>';
}
// ==== DISPLAY-CORE-END ====

module.exports = { esc, fmtPx, chg24, tfPct, magProgress, distToTargetPct, magRemaining, sigInForce, starSpan, sigChips };
