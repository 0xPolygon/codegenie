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

1. **Reentrancy.** Failure: external control precedes an invariant update. Unsafe: `call(user,credit[user]); credit[user]=0`. Safe: `due=credit[user]; credit[user]=0; checkedCall(user,due)`.
2. **Unchecked low-level failure.** Failure: failed `call`/`send` is recorded as success. Unsafe: `target.call(data); settled=true`. Safe: `(bool ok,)=target.call(data); require(ok); settled=true`.
3. **Inconsistent units.** Failure: token/feed decimal mismatch yields a wrong amount. Unsafe: `usdc.transfer(to,dollars*1e18)`. Safe: `usdc.transfer(to,dollars*1e6)`.
4. **Missing access control.** Failure: an unintended caller performs a privileged transition. Unsafe: `setOwner(next) external`. Safe: `setOwner(next) external onlyOwner`.
5. **Narrowing/truncation.** Failure: a cast discards required value. Unsafe: `uint128 saved=uint128(amount)`. Safe: `require(amount<=type(uint128).max); saved=uint128(amount)`.
6. **Repeated full `msg.value`.** Failure: a loop credits full payment repeatedly. Unsafe: `for(user:users) credit[user]+=msg.value`. Safe: `require(msg.value==each*users.length); for(user:users) credit[user]+=each`.
7. **Delegatecall storage hazard.** Failure: implementation writes collide with proxy authority/state. Unsafe: `Proxy.slot0=owner; Impl.slot0=total; delegatecall(Impl.set)`. Safe: `Proxy and Impl inherit ProxyStorage; target is allowlisted`.
8. **Invalid oracle data.** Failure: invalid or wrong-unit price reaches a consumer. Unsafe: `(,int a,,,)=feed.latestRoundData(); use(uint(a))`. Safe: `answer>0; updatedAt!=0; updatedAt<=now; now-updatedAt<=maxAge; normalize(feed.decimals())`.
9. **Required event omitted.** Failure: a transition is invisible to a required indexer/auditor. Unsafe: `owner=next`. Safe: `old=owner; owner=next; emit OwnershipTransferred(old,next)`.

# False Positives

- CEI/guards are safe when every entry updates invariants before external control.
- Typed reverting calls need no low-level result check unless a return value carries failure, the revert is caught, or a low-level primitive is used.
- Deliberate permissionless effects and documented compatible delegatecall layouts are safe when no privileged path or upgrade breaks them.
- Oracle consumers must check positive value, nonzero/nonfuture timestamp, feed-specific freshness, and units; optional events have no external correctness/audit contract.

# Safe Patterns

- Update state before calls, propagate outcomes, enforce roles, name units/ranges, and partition `msg.value`.
- Share/version delegate layouts, restrict targets, validate oracle value/time/units, and emit required events.
