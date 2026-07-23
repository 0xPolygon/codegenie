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

1. **Reentrancy.** Failure: a call precedes invariant update. Materiality: require reentry; severity by impact. Unsafe: `user.call{value:credit[user]}("");credit[user]=0`. Safe: `uint due=credit[user];credit[user]=0;(bool ok,)=user.call{value:due}("");require(ok)`. Mitigation: use CEI or a scoped guard.
2. **Unchecked low-level failure.** Failure: an ignored failure hides a required effect. Materiality: require reachable harm; severity by impact. Unsafe: `target.call(data);settled=true`. Safe: `(bool ok,)=target.call(data);require(ok);settled=true`. Mitigation: propagate low-level results.
3. **Inconsistent units.** Failure: mismatched decimals yield the wrong amount. Materiality: require unit mismatch; severity by impact. Unsafe: `usdc.transfer(to,dollars*1e18)`. Safe: `usdc.transfer(to,dollars*1e6)`. Mitigation: declare units; convert once.
4. **Missing access control.** Failure: any caller can perform a privileged transition. Materiality: require reachable privilege; severity by impact. Unsafe: `function setOwner(address n)external{owner=n;}`. Safe: `function setOwner(address n)external onlyOwner{owner=n;}`. Mitigation: enforce the intended role.
5. **Narrowing/truncation.** Failure: a cast discards required value. Materiality: require reachable loss; severity by impact. Unsafe: `uint128 saved=uint128(amount)`. Safe: `require(amount<=type(uint128).max);uint128 saved=uint128(amount)`. Mitigation: validate before narrowing.
6. **Repeated full `msg.value`.** Failure: a loop credits full value per user. Materiality: require repetition; severity by inflation. Unsafe: `function creditAll(address[] calldata users)external payable{for(uint256 i;i<users.length;++i)credit[users[i]]+=msg.value;}`. Safe: `function creditAll(address[] calldata users,uint256 each)external payable{require(msg.value==each * users.length);for(uint256 i;i<users.length;++i)credit[users[i]]+=each;}`. Mitigation: partition value before loops.
7. **Delegatecall storage hazard.** Failure: `total` overwrites the proxy's `owner` slot. Materiality: require layout mismatch; severity by authority impact. Unsafe: `contract Proxy{address owner;function run(address impl)external{(bool ok,)=impl.delegatecall(abi.encodeCall(Impl.set,(1)));require(ok);}}contract Impl{uint total;function set(uint n)external{total=n;}}`. Safe: `contract ProxyStorage{address owner;uint total;}contract Proxy is ProxyStorage{address immutable impl;constructor(address a){impl=a;}function set(uint n)external{(bool ok,)=impl.delegatecall(msg.data);require(ok);}}contract Impl is ProxyStorage{function set(uint n)external{total=n;}}`. Mitigation: constrain targets and share layout.
8. **Invalid oracle data.** Failure: stale data supplies a required fresh price. Materiality: require a violated guarantee; severity by impact. Unsafe: `function quote(uint amount)external view returns(uint){(,int p,,,)=feed.latestRoundData();return amount*uint(p);}`. Safe: `function quote(uint amount)external view returns(uint){(uint80 roundId,int p,,uint updatedAt,uint80 answeredInRound)=feed.latestRoundData();require(p>0 && answeredInRound >= roundId && updatedAt + 1 hours >= block.timestamp);return amount*uint(p);}`. Mitigation: validate sign, round, freshness.
9. **Required event omitted.** Failure: owner change is invisible to a required indexer. Materiality: require missed transition; severity by impact. Unsafe: `function transferOwnership(address next)external onlyOwner{owner=next;}`. Safe: `function transferOwnership(address next)external onlyOwner{address old=owner;owner=next;emit OwnershipTransferred(old,next);}`. Mitigation: emit events with transitions.

# False Positives

- Exclude CEI/guards, typed reverting calls, deliberate permissionless effects.
- Exclude documented compatible delegatecall layouts; events no external correctness/audit contract requires.

# Safe Patterns

- Secure state before calls, propagate results, enforce roles, name units/ranges, and partition call value.
- Constrain delegatecall layouts, validate oracle data, and emit contractually required events.

# Examples

Require impact evidence.
