// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * TokenBilling: usage-based USDT debits with limits the USER controls.
 *
 * How it works
 *  1. User approves this contract on the USDT contract (e.g. 1000 USDT).
 *  2. User calls enroll(maxPerCharge, maxPerPeriod) to set their own limits.
 *  3. The store's keeper wallet calls charge(user, amount, invoiceId).
 *     The contract only allows it if:
 *       - the user is enrolled and the contract isn't paused,
 *       - amount <= user's maxPerCharge,
 *       - total charged in the current 30-day period stays <= maxPerPeriod,
 *       - the invoiceId was never used before (no double charging).
 *     Money always goes to the treasury, never to the keeper.
 *  4. User can lower/raise limits or cancel() at any time, or simply revoke
 *     the USDT approval in their wallet.
 *
 * Roles
 *  - owner:    sets keeper/treasury, pauses. Keep it OFF the server (hardware wallet / Safe).
 *  - keeper:   the server's hot wallet. Can only call charge().
 *  - treasury: receives all payments.
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract TokenBilling {
    IERC20 public immutable token;
    address public owner;
    address public keeper;
    address public treasury;
    bool public paused;

    uint64 public constant PERIOD = 30 days;

    struct Account {
        bool active;
        uint128 maxPerCharge;   // in token base units
        uint128 maxPerPeriod;   // in token base units, per 30 days
        uint64 periodStart;
        uint128 spentInPeriod;
    }

    mapping(address => Account) public accounts;
    mapping(bytes32 => bool) public invoiceUsed;

    event Enrolled(address indexed user, uint256 maxPerCharge, uint256 maxPerPeriod);
    event LimitsChanged(address indexed user, uint256 maxPerCharge, uint256 maxPerPeriod);
    event Cancelled(address indexed user);
    event Charged(address indexed user, uint256 amount, bytes32 indexed invoiceId);
    event KeeperChanged(address keeper);
    event TreasuryChanged(address treasury);
    event PausedSet(bool paused);
    event OwnershipTransferred(address from, address to);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _token, address _treasury, address _keeper) {
        require(_token != address(0) && _treasury != address(0) && _keeper != address(0), "zero address");
        token = IERC20(_token);
        owner = msg.sender;
        treasury = _treasury;
        keeper = _keeper;
        emit OwnershipTransferred(address(0), msg.sender);
        emit TreasuryChanged(_treasury);
        emit KeeperChanged(_keeper);
    }

    // ------------------------------------------------------------ user side

    function enroll(uint128 maxPerCharge, uint128 maxPerPeriod) external {
        _checkLimits(maxPerCharge, maxPerPeriod);
        Account storage a = accounts[msg.sender];
        a.active = true;
        a.maxPerCharge = maxPerCharge;
        a.maxPerPeriod = maxPerPeriod;
        if (a.periodStart == 0 || block.timestamp >= a.periodStart + PERIOD) {
            a.periodStart = uint64(block.timestamp);
            a.spentInPeriod = 0;
        }
        emit Enrolled(msg.sender, maxPerCharge, maxPerPeriod);
    }

    function setLimits(uint128 maxPerCharge, uint128 maxPerPeriod) external {
        Account storage a = accounts[msg.sender];
        require(a.active, "not enrolled");
        _checkLimits(maxPerCharge, maxPerPeriod);
        a.maxPerCharge = maxPerCharge;
        a.maxPerPeriod = maxPerPeriod;
        emit LimitsChanged(msg.sender, maxPerCharge, maxPerPeriod);
    }

    function cancel() external {
        require(accounts[msg.sender].active, "not enrolled");
        accounts[msg.sender].active = false;
        emit Cancelled(msg.sender);
    }

    // ------------------------------------------------------------ keeper side

    function charge(address user, uint256 amount, bytes32 invoiceId) external {
        require(msg.sender == keeper, "not keeper");
        require(!paused, "paused");
        require(!invoiceUsed[invoiceId], "invoice already charged");
        Account storage a = accounts[user];
        require(a.active, "user not enrolled");
        require(amount > 0, "zero amount");
        require(amount <= a.maxPerCharge, "over per-charge limit");

        if (block.timestamp >= a.periodStart + PERIOD) {
            a.periodStart = uint64(block.timestamp);
            a.spentInPeriod = 0;
        }
        require(uint256(a.spentInPeriod) + amount <= a.maxPerPeriod, "over 30-day limit");

        // effects before the external call
        a.spentInPeriod += uint128(amount);
        invoiceUsed[invoiceId] = true;

        _safeTransferFrom(user, treasury, amount);
        emit Charged(user, amount, invoiceId);
    }

    // ------------------------------------------------------------ views

    /// How much more can be charged in the current 30-day window.
    function remainingInPeriod(address user) external view returns (uint256) {
        Account storage a = accounts[user];
        if (!a.active) return 0;
        if (block.timestamp >= a.periodStart + PERIOD) return a.maxPerPeriod;
        return a.maxPerPeriod - a.spentInPeriod;
    }

    // ------------------------------------------------------------ owner

    function setKeeper(address _keeper) external onlyOwner {
        require(_keeper != address(0), "zero address");
        keeper = _keeper;
        emit KeeperChanged(_keeper);
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "zero address");
        treasury = _treasury;
        emit TreasuryChanged(_treasury);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero address");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    // ------------------------------------------------------------ internal

    function _checkLimits(uint128 maxPerCharge, uint128 maxPerPeriod) private pure {
        require(maxPerCharge > 0 && maxPerPeriod > 0, "limits must be > 0");
        require(maxPerCharge <= maxPerPeriod, "per-charge limit above 30-day limit");
    }

    /// Works with tokens that return bool and with ones that return nothing.
    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "token transfer failed (balance or approval too low)");
    }
}
