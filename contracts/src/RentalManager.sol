// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RobotRegistry} from "./RobotRegistry.sol";

/// @title RentalManager
/// @notice Authoritative record of the rental lifecycle: start, meter, complete, settle.
/// @dev Custody of funds lives in the operator's programmatic wallets. This contract records
///      what was agreed and what was settled, so both sides of the marketplace can audit a
///      rental without trusting the operator's database.
contract RentalManager {
    enum RentalState {
        None,
        Active,
        Completed,
        Settled,
        Cancelled
    }

    struct Rental {
        uint256 robotId;
        address renter;
        address owner;
        RentalState state;
        uint64 startedAt;
        uint64 endedAt;
        uint64 meteredMinutes;
        uint64 tasksCompleted;
        uint32 surgeBps;
        uint256 authorizedAmount;
        uint256 fareAmount;
        uint256 platformFee;
        uint256 ownerPayout;
        bytes32 holdRef;
        bytes32 settlementRef;
    }

    uint32 public constant BPS_DENOMINATOR = 10_000;
    /// @dev One cent, in USDC minor units. Fees are quantised to this so that the fee and the
    ///      payout recorded here sum to the fare at the precision fares are quoted in.
    uint256 public constant FEE_QUANTUM = 10_000;
    uint32 public constant MAX_PLATFORM_FEE_BPS = 3_000;
    uint32 public constant MAX_SURGE_BPS = 50_000;

    RobotRegistry public immutable registry;

    address public admin;
    address public settlementOperator;
    uint32 public platformFeeBps;

    uint256 public nextRentalId;
    mapping(uint256 => Rental) private rentals;
    mapping(address => uint256[]) private rentalsByRenter;
    mapping(uint256 => uint256[]) private rentalsByRobot;

    event RentalStarted(
        uint256 indexed rentalId,
        uint256 indexed robotId,
        address indexed renter,
        address owner,
        uint256 authorizedAmount,
        uint32 surgeBps,
        bytes32 holdRef
    );
    event RentalMetered(uint256 indexed rentalId, uint64 meteredMinutes, uint64 tasksCompleted);
    event RentalCompleted(uint256 indexed rentalId, uint64 endedAt, uint64 meteredMinutes, uint64 tasksCompleted);
    event RentalSettled(
        uint256 indexed rentalId,
        uint256 fareAmount,
        uint256 platformFee,
        uint256 ownerPayout,
        bytes32 settlementRef
    );
    event RentalCancelled(uint256 indexed rentalId, string reason);
    event PlatformFeeChanged(uint32 previousBps, uint32 currentBps);
    event SettlementOperatorChanged(address indexed previous, address indexed current);

    error NotAdmin();
    error NotSettlementOperator();
    error UnknownRental();
    error WrongState();
    error FeeTooHigh();
    error SurgeOutOfRange();
    error FareExceedsAuthorization();
    error MeterWentBackwards();
    error ZeroAddress();
    error ZeroAuthorization();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != settlementOperator) revert NotSettlementOperator();
        _;
    }

    modifier inState(uint256 rentalId, RentalState expected) {
        RentalState state = rentals[rentalId].state;
        if (state == RentalState.None) revert UnknownRental();
        if (state != expected) revert WrongState();
        _;
    }

    constructor(address admin_, address registry_, uint32 platformFeeBps_) {
        if (admin_ == address(0) || registry_ == address(0)) revert ZeroAddress();
        if (platformFeeBps_ > MAX_PLATFORM_FEE_BPS) revert FeeTooHigh();

        admin = admin_;
        registry = RobotRegistry(registry_);
        platformFeeBps = platformFeeBps_;
    }

    function setSettlementOperator(address operator) external onlyAdmin {
        if (operator == address(0)) revert ZeroAddress();
        emit SettlementOperatorChanged(settlementOperator, operator);
        settlementOperator = operator;
    }

    function setPlatformFeeBps(uint32 feeBps) external onlyAdmin {
        if (feeBps > MAX_PLATFORM_FEE_BPS) revert FeeTooHigh();
        emit PlatformFeeChanged(platformFeeBps, feeBps);
        platformFeeBps = feeBps;
    }

    /// @notice Open a rental once the authorization hold has been placed against the renter balance.
    /// @param holdRef Opaque reference to that hold.
    function startRental(
        uint256 robotId,
        address renter,
        uint256 authorizedAmount,
        uint32 surgeBps,
        bytes32 holdRef
    ) external onlyOperator returns (uint256 rentalId) {
        if (renter == address(0)) revert ZeroAddress();
        if (authorizedAmount == 0) revert ZeroAuthorization();
        if (surgeBps < BPS_DENOMINATOR || surgeBps > MAX_SURGE_BPS) revert SurgeOutOfRange();

        address owner = registry.ownerOf(robotId);
        registry.markRented(robotId);

        rentalId = nextRentalId++;
        rentals[rentalId] = Rental({
            robotId: robotId,
            renter: renter,
            owner: owner,
            state: RentalState.Active,
            startedAt: uint64(block.timestamp),
            endedAt: 0,
            meteredMinutes: 0,
            tasksCompleted: 0,
            surgeBps: surgeBps,
            authorizedAmount: authorizedAmount,
            fareAmount: 0,
            platformFee: 0,
            ownerPayout: 0,
            holdRef: holdRef,
            settlementRef: bytes32(0)
        });
        rentalsByRenter[renter].push(rentalId);
        rentalsByRobot[robotId].push(rentalId);

        emit RentalStarted(rentalId, robotId, renter, owner, authorizedAmount, surgeBps, holdRef);
    }

    /// @notice Push meter readings for an active rental. Readings are monotonic.
    function recordMeter(uint256 rentalId, uint64 meteredMinutes, uint64 tasksCompleted)
        external
        onlyOperator
        inState(rentalId, RentalState.Active)
    {
        Rental storage rental = rentals[rentalId];
        if (meteredMinutes < rental.meteredMinutes || tasksCompleted < rental.tasksCompleted) {
            revert MeterWentBackwards();
        }

        rental.meteredMinutes = meteredMinutes;
        rental.tasksCompleted = tasksCompleted;

        emit RentalMetered(rentalId, meteredMinutes, tasksCompleted);
    }

    /// @notice Stop the meter. The fare is computed off-chain and written back by settleRental.
    function completeRental(uint256 rentalId, uint64 meteredMinutes, uint64 tasksCompleted)
        external
        onlyOperator
        inState(rentalId, RentalState.Active)
    {
        Rental storage rental = rentals[rentalId];
        if (meteredMinutes < rental.meteredMinutes || tasksCompleted < rental.tasksCompleted) {
            revert MeterWentBackwards();
        }

        rental.meteredMinutes = meteredMinutes;
        rental.tasksCompleted = tasksCompleted;
        rental.endedAt = uint64(block.timestamp);
        rental.state = RentalState.Completed;

        emit RentalCompleted(rentalId, rental.endedAt, meteredMinutes, tasksCompleted);
    }

    /// @notice Record the captured fare and its split after funds have moved between wallets.
    /// @param settlementRef Opaque reference to the transfer batch that moved the funds.
    function settleRental(uint256 rentalId, uint256 fareAmount, bytes32 settlementRef)
        external
        onlyOperator
        inState(rentalId, RentalState.Completed)
        returns (uint256 platformFee, uint256 ownerPayout)
    {
        Rental storage rental = rentals[rentalId];
        if (fareAmount > rental.authorizedAmount) revert FareExceedsAuthorization();

        platformFee = _splitFee(fareAmount);
        ownerPayout = fareAmount - platformFee;

        rental.fareAmount = fareAmount;
        rental.platformFee = platformFee;
        rental.ownerPayout = ownerPayout;
        rental.settlementRef = settlementRef;
        rental.state = RentalState.Settled;

        registry.markReturned(rental.robotId, true);

        emit RentalSettled(rentalId, fareAmount, platformFee, ownerPayout, settlementRef);
    }

    /// @notice Void a rental that never produced a billable fare. The hold is released off-chain.
    function cancelRental(uint256 rentalId, string calldata reason) external onlyOperator {
        Rental storage rental = rentals[rentalId];
        if (rental.state == RentalState.None) revert UnknownRental();
        if (rental.state != RentalState.Active && rental.state != RentalState.Completed) revert WrongState();

        rental.state = RentalState.Cancelled;
        rental.endedAt = uint64(block.timestamp);
        registry.markReturned(rental.robotId, false);

        emit RentalCancelled(rentalId, reason);
    }

    function getRental(uint256 rentalId) external view returns (Rental memory) {
        if (rentals[rentalId].state == RentalState.None) revert UnknownRental();
        return rentals[rentalId];
    }

    function rentalsOf(address renter) external view returns (uint256[] memory) {
        return rentalsByRenter[renter];
    }

    function rentalsForRobot(uint256 robotId) external view returns (uint256[] memory) {
        return rentalsByRobot[robotId];
    }

    function quoteSplit(uint256 fareAmount) external view returns (uint256 platformFee, uint256 ownerPayout) {
        platformFee = _splitFee(fareAmount);
        ownerPayout = fareAmount - platformFee;
    }

    /// @dev Rounds the fee to the nearest cent, half up, and never above the fare itself.
    function _splitFee(uint256 fareAmount) private view returns (uint256) {
        uint256 exact = (fareAmount * platformFeeBps) / BPS_DENOMINATOR;
        uint256 rounded = ((exact + FEE_QUANTUM / 2) / FEE_QUANTUM) * FEE_QUANTUM;
        return rounded > fareAmount ? fareAmount : rounded;
    }
}
