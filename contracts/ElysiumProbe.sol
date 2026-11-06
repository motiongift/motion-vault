// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// ElysiumProbe (motion vault, Elysium lane; 2026-11-03). NEVER DEPLOYED: it exists only as eth_call state-override code put
// at the trading wallet's OWN address for one read-only call (the same trick as the engine's ETH_DELTA_CODE forwarder).
// Every external call it makes therefore comes from the wallet itself (msg.sender = the wallet), against the live chain
// state, and nothing persists: an eth_call writes nothing.
//
// For each case (one candidate pool):
//   1. existence: a staticcall that must answer a non-zero first word (a V3 pool's slot0(), a V4 PoolManager's
//      extsload(pool state slot)); a pool that does not exist is skipped (ran = false)
//   2. buy (buyValue > 0): the router call exactly as the engine would sign it, with a zero floor, paying buyValue in the
//      native coin: what the wallet received of the coin, what native left it, the gas the router used
//   3. transfer test (transferBps > 0): that share of what the buy delivered sent to a fresh address: what arrived (a tax)
//   4. sell (sellData non-empty): the engine's EXACT approvals (the coin to Permit2 for exactly the amount, reset to 0 first
//      when an older smaller allowance is there; Permit2 to the router for exactly the amount, 15 minutes), then the router's
//      sell of everything the buy delivered (or sellAmount) with a zero floor, its amount written into the calldata at
//      sellAt: what native came back, what coin left, the gas
//   5. routerKept: the router holds more native / wrapped / coin after the case than before (a router must keep nothing)
// Each case runs in a self-call that ALWAYS reverts with its result (TAG + abi.encode(Seen)), so no case sees another
// case's state; run() collects them. A case whose self-call reverts for any other reason comes back with err = that revert.
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
}

interface IPermit2 {
    function allowance(address user, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce);
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

contract ElysiumProbe {
    bytes4 private constant TAG = 0x7e1f5e00;

    struct Case {
        address router;
        address coin;
        address wrapped;
        address permit2;
        address check;
        bytes checkData;
        uint256 buyValue;
        bytes buyData;
        bytes sellData;
        uint256[] sellAt;
        uint256 sellAmount;
        uint256 transferBps;
    }

    struct Seen {
        bool ran;
        bool buyOk;
        uint256 coinGot;
        uint256 nativeSpent;
        uint256 buyGas;
        bool sellOk;
        uint256 coinSold;
        uint256 nativeBack;
        uint256 sellGas;
        uint256 taxSent;
        uint256 taxGot;
        bool routerKept;
        bytes err;
    }

    receive() external payable {}

    function run(Case[] calldata cs) external returns (Seen[] memory out) {
        out = new Seen[](cs.length);
        for (uint256 i; i < cs.length; ++i) {
            (, bytes memory r) = address(this).call(abi.encodeCall(this.one, (cs[i])));
            if (r.length >= 4 + 32 * 13 && bytes4(r) == TAG) {
                assembly {
                    let n := sub(mload(r), 4)
                    r := add(r, 4)
                    mstore(r, n)
                }
                out[i] = abi.decode(r, (Seen));
            } else {
                out[i].err = _cut(r);
            }
        }
    }

    function one(Case calldata c) external {
        require(msg.sender == address(this));
        Seen memory s;
        if (c.check != address(0)) {
            (bool ok, bytes memory r) = c.check.staticcall(c.checkData);
            if (!ok || r.length < 32 || abi.decode(r, (uint256)) == 0) _done(s);
        }
        s.ran = true;
        uint256 rN0 = c.router.balance;
        uint256 rW0 = _bal(c.wrapped, c.router);
        uint256 rC0 = _bal(c.coin, c.router);
        uint256 amount = c.sellAmount;
        if (c.buyValue > 0) {
            uint256 c0 = _bal(c.coin, address(this));
            uint256 n0 = address(this).balance;
            uint256 g = gasleft();
            (bool ok, bytes memory r) = c.router.call{value: c.buyValue}(c.buyData);
            s.buyGas = g - gasleft();
            if (!ok) {
                s.err = _cut(r);
                s.routerKept = _kept(c, rN0, rW0, rC0);
                _done(s);
            }
            s.buyOk = true;
            s.coinGot = _sub(_bal(c.coin, address(this)), c0);
            s.nativeSpent = _sub(n0, address(this).balance);
            amount = s.coinGot;
        }
        // r2: transferBps of what the buy delivered goes to a fresh address first; a refused transfer arrives as 0 (taxGot 0)
        uint256 t = c.transferBps > 0 && c.transferBps <= 10_000 ? (amount * c.transferBps) / 10_000 : 0;
        if (t > 0) {
            address fresh = address(uint160(uint256(keccak256(abi.encode(address(this), "motion-elysium-probe")))));
            uint256 f0 = _bal(c.coin, fresh);
            (bool ok, ) = c.coin.call(abi.encodeWithSignature("transfer(address,uint256)", fresh, t));
            s.taxSent = t;
            if (ok) {
                s.taxGot = _sub(_bal(c.coin, fresh), f0);
                amount -= t;
            }
        }
        if (c.sellData.length > 0 && amount > 0 && amount < (1 << 160)) _sell(c, amount, s);
        s.routerKept = _kept(c, rN0, rW0, rC0);
        _done(s);
    }

    function _sell(Case calldata c, uint256 amount, Seen memory s) private {
        bytes memory d = c.sellData;
        for (uint256 k; k < c.sellAt.length; ++k) {
            uint256 at = c.sellAt[k];
            require(at + 32 <= d.length);
            assembly {
                mstore(add(add(d, 32), at), amount)
            }
        }
        _approvals(c, amount);
        uint256 c1 = _bal(c.coin, address(this));
        uint256 n1 = address(this).balance;
        uint256 g = gasleft();
        (bool ok, bytes memory r) = c.router.call(d);
        s.sellGas = g - gasleft();
        if (!ok) {
            s.err = _cut(r);
        } else {
            s.sellOk = true;
            s.coinSold = _sub(c1, _bal(c.coin, address(this)));
            s.nativeBack = _sub(address(this).balance, n1);
        }
    }

    // the engine's exact approvals: the coin to Permit2 for exactly amount (0 first over an older smaller allowance),
    // Permit2 to the router for exactly amount, 15 minutes; a standing allowance that already covers it is left alone
    function _approvals(Case calldata c, uint256 amount) private {
        uint256 a = _allowance(c.coin, c.permit2);
        if (a < amount) {
            if (a > 0) _call(c.coin, abi.encodeWithSignature("approve(address,uint256)", c.permit2, uint256(0)));
            _call(c.coin, abi.encodeWithSignature("approve(address,uint256)", c.permit2, amount));
        }
        (bool pOk, bytes memory pr) = c.permit2.staticcall(abi.encodeCall(IPermit2.allowance, (address(this), c.coin, c.router)));
        uint160 pAmount;
        uint48 pExp;
        if (pOk && pr.length >= 96) (pAmount, pExp, ) = abi.decode(pr, (uint160, uint48, uint48));
        if (pAmount < amount || pExp <= block.timestamp) {
            _call(c.permit2, abi.encodeCall(IPermit2.approve, (c.coin, c.router, uint160(amount), uint48(block.timestamp + 900))));
        }
    }

    function _kept(Case calldata c, uint256 rN0, uint256 rW0, uint256 rC0) private view returns (bool) {
        return c.router.balance > rN0 || _bal(c.wrapped, c.router) > rW0 || _bal(c.coin, c.router) > rC0;
    }

    function _done(Seen memory s) private pure {
        bytes memory r = abi.encodePacked(TAG, abi.encode(s));
        assembly {
            revert(add(r, 32), mload(r))
        }
    }

    function _bal(address t, address who) private view returns (uint256 v) {
        if (t == address(0)) return 0;
        (bool ok, bytes memory r) = t.staticcall(abi.encodeCall(IERC20.balanceOf, (who)));
        if (ok && r.length >= 32) v = abi.decode(r, (uint256));
    }

    function _allowance(address t, address spender) private view returns (uint256 v) {
        (bool ok, bytes memory r) = t.staticcall(abi.encodeCall(IERC20.allowance, (address(this), spender)));
        if (ok && r.length >= 32) v = abi.decode(r, (uint256));
    }

    function _call(address t, bytes memory d) private {
        (bool ok, ) = t.call(d);
        ok;
    }

    function _sub(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    function _cut(bytes memory r) private pure returns (bytes memory) {
        if (r.length <= 256) return r;
        bytes memory o = new bytes(256);
        for (uint256 i; i < 256; ++i) o[i] = r[i];
        return o;
    }
}
