---
id: lang/solidity
title: Solidity correctness and security
lenses: ["lang/solidity"]
languages: ["solidity"]
categories: ["correctness", "security", "reliability"]
enabledByDefault: true
---

# Purpose

Find reachable Solidity asset, authority, accounting, and state-machine failures without flagging established safe patterns.

# Checks

1. **Reentrancy.** Look for: external control precedes an invariant update. Unsafe: `call(user,credit[user]); credit[user]=0`. Safe: `due=credit[user]; credit[user]=0; checkedCall(user,due)`.
2. **Unchecked low-level failure.** Look for: failed `call`/`send` is recorded as success. Unsafe: `target.call(data); settled=true`. Safe: `(bool ok,)=target.call(data); require(ok); settled=true`.
3. **Inconsistent units.** Look for: token/feed decimal mismatch yields a wrong amount. Unsafe: `usdc.transfer(to,dollars*1e18)`. Safe: `usdc.transfer(to,dollars*1e6)`.
4. **Missing access control.** Look for: an unintended caller performs a privileged transition. Unsafe: `setOwner(next) external`. Safe: `setOwner(next) external onlyOwner`.
5. **Narrowing/truncation.** Look for: a cast discards required value. Unsafe: `uint128 saved=uint128(amount)`. Safe: `require(amount<=type(uint128).max); saved=uint128(amount)`.
6. **Repeated full `msg.value`.** Look for: a loop credits full payment repeatedly. Unsafe: `for(user:users) credit[user]+=msg.value`. Safe: `require(msg.value==each*users.length); for(user:users) credit[user]+=each`.
7. **Delegatecall storage hazard.** Look for: implementation writes collide with proxy authority/state. Unsafe: `Proxy.slot0=owner; Impl.slot0=total; delegatecall(Impl.set)`. Safe: `Proxy and Impl inherit ProxyStorage; target is allowlisted`.
8. **Invalid oracle data.** Look for: invalid or wrong-unit price reaches a consumer. Unsafe: `(,int a,,,)=feed.latestRoundData(); use(uint(a))`. Safe: `answer>0; updatedAt!=0; updatedAt<=now; now-updatedAt<=maxAge; normalize(feed.decimals())`.
9. **Required event omitted.** Look for: a transition is invisible to a required indexer/auditor. Unsafe: `owner=next`. Safe: `old=owner; owner=next; emit OwnershipTransferred(old,next)`.

# False Positives

- **Reentrancy** — require reachable reentry; severity by state/asset impact.
- **Unchecked low-level failure** — require downstream harm; severity by impact.
- **Inconsistent units** — require both units; severity by asset error.
- **Missing access control** — require caller/effect; severity by authority.
- **Narrowing/truncation** — require out-of-range input and consumer; severity by impact.
- **Repeated full `msg.value`** — require multiple iterations; severity by inflation.
- **Delegatecall storage hazard** — require target, slot, and write; severity by impact.
- **Invalid oracle data** — require feed guarantee/max age/units; severity by asset impact.
- **Required event omitted** — require consumer/transition; severity by impact.

- CEI/guards are safe when every entry updates invariants before external control.
- Typed reverting calls need no low-level result check unless a return value carries failure, the revert is caught, or a low-level primitive is used.
- Deliberate permissionless effects and documented compatible delegatecall layouts are safe when no privileged path or upgrade breaks them.
- Oracle consumers must check positive value, nonzero/nonfuture timestamp, feed-specific freshness, and units; optional events have no external correctness/audit contract.

# Safe Patterns

- Update state before calls, propagate outcomes, enforce roles, name units/ranges, and partition `msg.value`.
- Share/version delegate layouts, restrict targets, validate oracle value/time/units, and emit required events.
