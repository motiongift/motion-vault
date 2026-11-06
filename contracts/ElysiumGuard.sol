// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// The probe's existence check of one Elysium pool (release 6, 2026-11-04; src/elysiumCore.ts ELY_GUARD). Never deployed: the
/// probe's eth_call puts this code at a fixed empty address with a state override, like the probe itself (elyProbeState).
/// check() answers the pool's state word (V3 slot0's first word / V4 PoolManager.extsload(the pool's slot0); 0 = no pool) ONLY when
///   - the router the case trades through has exactly the pinned runtime code (EXTCODEHASH; no code / other code = 0), and
///   - a pool behind a swap hook: the hook has exactly the pinned runtime code, and
///   - every rule holds: the hook's own fee / tax / launch-window reads (view calls on the live state, this same eth_call).
/// Anything else answers 0, or reverts: the probe then treats the case as "no pool" (never picked, never signed).
contract ElysiumGuard {
    /// one view call and one condition on its answer (words are 32-byte words of the raw answer, from 0)
    struct Rule {
        address target;
        bytes data;
        uint8 op;
        uint16 i;
        uint16 j;
        uint16 k;
        uint256 value;
    }

    uint8 internal constant LE = 1;        // word i <= value
    uint8 internal constant HASH = 2;      // keccak256(the whole answer) == bytes32(value)
    uint8 internal constant AFTER = 3;     // word i + value <= block.timestamp
    uint8 internal constant WINDOW_LE = 4; // word i + word j <= block.timestamp, or else word k <= value

    function check(
        address router,
        bytes32 routerHash,
        address hook,
        bytes32 hookHash,
        address target,
        bytes calldata data,
        Rule[] calldata rules
    ) external view returns (uint256) {
        // a zero pin never matches (EXTCODEHASH of an account that does not exist is 0)
        if (routerHash == bytes32(0) || router.codehash != routerHash) return 0;
        if (hook != address(0) && (hookHash == bytes32(0) || hook.codehash != hookHash)) return 0;
        for (uint256 n = 0; n < rules.length; n++) {
            if (!_holds(rules[n])) return 0;
        }
        (bool ok, bytes memory r) = target.staticcall(data);
        if (!ok || r.length < 32) return 0;
        return abi.decode(r, (uint256));
    }

    function _holds(Rule calldata u) private view returns (bool) {
        (bool ok, bytes memory r) = u.target.staticcall(u.data);
        if (!ok) return false;
        if (u.op == HASH) return keccak256(r) == bytes32(u.value);
        if (u.op == LE) return r.length >= (uint256(u.i) + 1) * 32 && _word(r, u.i) <= u.value;
        if (u.op == AFTER) return r.length >= (uint256(u.i) + 1) * 32 && _word(r, u.i) + u.value <= block.timestamp;
        if (u.op == WINDOW_LE) {
            uint256 need = (uint256(_max3(u.i, u.j, u.k)) + 1) * 32;
            if (r.length < need) return false;
            if (_word(r, u.i) + _word(r, u.j) <= block.timestamp) return true;
            return _word(r, u.k) <= u.value;
        }
        return false;
    }

    function _word(bytes memory r, uint256 i) private pure returns (uint256 w) {
        assembly {
            w := mload(add(add(r, 32), mul(i, 32)))
        }
    }

    function _max3(uint16 a, uint16 b, uint16 c) private pure returns (uint16) {
        uint16 m = a > b ? a : b;
        return m > c ? m : c;
    }
}
