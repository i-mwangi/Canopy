// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RobotRegistry
/// @notice On-chain record of rentable robots, their owners, and their rate cards.
contract RobotRegistry {
    enum RobotClass {
        Picking,
        Packing,
        Delivery
    }

    enum RobotStatus {
        Unlisted,
        Available,
        Rented,
        Maintenance
    }

    struct RateCard {
        uint64 baseFare;
        uint64 perMinute;
        uint64 perTask;
        uint64 minimumFare;
    }

    struct Robot {
        address owner;
        RobotClass class_;
        RobotStatus status;
        RateCard rates;
        string metadataUri;
        uint64 completedRentals;
    }

    address public admin;
    address public rentalManager;

    uint256 public nextRobotId;
    mapping(uint256 => Robot) private robots;
    mapping(address => uint256[]) private robotsByOwner;
    mapping(RobotClass => uint256) public availableByClass;

    event RobotListed(uint256 indexed robotId, address indexed owner, RobotClass class_, string metadataUri);
    event RobotDelisted(uint256 indexed robotId, address indexed owner);
    event RateCardUpdated(uint256 indexed robotId, RateCard rates);
    event RobotStatusChanged(uint256 indexed robotId, RobotStatus previous, RobotStatus current);
    event RentalManagerChanged(address indexed previous, address indexed current);

    error NotAdmin();
    error NotRobotOwner();
    error NotRentalManager();
    error UnknownRobot();
    error InvalidStatusTransition();
    error InvalidRateCard();
    error ZeroAddress();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyRentalManager() {
        if (msg.sender != rentalManager) revert NotRentalManager();
        _;
    }

    modifier robotExists(uint256 robotId) {
        if (robots[robotId].owner == address(0)) revert UnknownRobot();
        _;
    }

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
    }

    function setRentalManager(address manager) external onlyAdmin {
        if (manager == address(0)) revert ZeroAddress();
        emit RentalManagerChanged(rentalManager, manager);
        rentalManager = manager;
    }

    /// @notice List a robot for rent. Callable by the owner directly.
    function listRobot(RobotClass class_, RateCard calldata rates, string calldata metadataUri)
        external
        returns (uint256 robotId)
    {
        _validateRates(rates);

        robotId = nextRobotId++;
        robots[robotId] = Robot({
            owner: msg.sender,
            class_: class_,
            status: RobotStatus.Available,
            rates: rates,
            metadataUri: metadataUri,
            completedRentals: 0
        });
        robotsByOwner[msg.sender].push(robotId);
        availableByClass[class_] += 1;

        emit RobotListed(robotId, msg.sender, class_, metadataUri);
        emit RateCardUpdated(robotId, rates);
        emit RobotStatusChanged(robotId, RobotStatus.Unlisted, RobotStatus.Available);
    }

    function updateRateCard(uint256 robotId, RateCard calldata rates) external robotExists(robotId) {
        Robot storage robot = robots[robotId];
        if (robot.owner != msg.sender) revert NotRobotOwner();
        _validateRates(rates);

        robot.rates = rates;
        emit RateCardUpdated(robotId, rates);
    }

    /// @notice Owner-driven availability toggle. A rented robot cannot be pulled mid-rental.
    function setAvailability(uint256 robotId, bool available) external robotExists(robotId) {
        Robot storage robot = robots[robotId];
        if (robot.owner != msg.sender) revert NotRobotOwner();
        if (robot.status == RobotStatus.Rented) revert InvalidStatusTransition();

        RobotStatus next = available ? RobotStatus.Available : RobotStatus.Maintenance;
        _transition(robotId, robot, next);
    }

    function delistRobot(uint256 robotId) external robotExists(robotId) {
        Robot storage robot = robots[robotId];
        if (robot.owner != msg.sender) revert NotRobotOwner();
        if (robot.status == RobotStatus.Rented) revert InvalidStatusTransition();

        _transition(robotId, robot, RobotStatus.Unlisted);
        emit RobotDelisted(robotId, robot.owner);
    }

    /// @notice Reserve a robot for a rental. Only the rental manager may claim capacity.
    function markRented(uint256 robotId) external onlyRentalManager robotExists(robotId) {
        Robot storage robot = robots[robotId];
        if (robot.status != RobotStatus.Available) revert InvalidStatusTransition();
        _transition(robotId, robot, RobotStatus.Rented);
    }

    /// @notice Return a robot to the pool once its rental has settled.
    function markReturned(uint256 robotId, bool completed) external onlyRentalManager robotExists(robotId) {
        Robot storage robot = robots[robotId];
        if (robot.status != RobotStatus.Rented) revert InvalidStatusTransition();
        if (completed) robot.completedRentals += 1;
        _transition(robotId, robot, RobotStatus.Available);
    }

    function getRobot(uint256 robotId) external view robotExists(robotId) returns (Robot memory) {
        return robots[robotId];
    }

    function ownerOf(uint256 robotId) external view robotExists(robotId) returns (address) {
        return robots[robotId].owner;
    }

    function rateCardOf(uint256 robotId) external view robotExists(robotId) returns (RateCard memory) {
        return robots[robotId].rates;
    }

    function statusOf(uint256 robotId) external view robotExists(robotId) returns (RobotStatus) {
        return robots[robotId].status;
    }

    function robotsOf(address owner) external view returns (uint256[] memory) {
        return robotsByOwner[owner];
    }

    function _transition(uint256 robotId, Robot storage robot, RobotStatus next) private {
        RobotStatus previous = robot.status;
        if (previous == next) return;

        if (previous == RobotStatus.Available) availableByClass[robot.class_] -= 1;
        if (next == RobotStatus.Available) availableByClass[robot.class_] += 1;

        robot.status = next;
        emit RobotStatusChanged(robotId, previous, next);
    }

    function _validateRates(RateCard calldata rates) private pure {
        if (rates.baseFare == 0 && rates.perMinute == 0 && rates.perTask == 0) revert InvalidRateCard();
        if (rates.minimumFare < rates.baseFare) revert InvalidRateCard();
    }
}
