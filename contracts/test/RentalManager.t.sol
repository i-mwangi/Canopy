// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RobotRegistry} from "../src/RobotRegistry.sol";
import {RentalManager} from "../src/RentalManager.sol";

contract RentalManagerTest is Test {
    RobotRegistry private registry;
    RentalManager private manager;

    address private admin = address(0xA11CE);
    address private operator = address(0x00E0);
    address private owner = address(0xC0FFEE);
    address private renter = address(0xBEEF);
    address private stranger = address(0xDEAD);

    uint256 private robotId;

    function setUp() public {
        registry = new RobotRegistry(admin);
        manager = new RentalManager(admin, address(registry), 1500);

        vm.startPrank(admin);
        registry.setRentalManager(address(manager));
        manager.setSettlementOperator(operator);
        vm.stopPrank();

        vm.prank(owner);
        robotId = registry.listRobot(
            RobotRegistry.RobotClass.Delivery,
            RobotRegistry.RateCard({baseFare: 3e6, perMinute: 5e5, perTask: 9e5, minimumFare: 4e6}),
            "ipfs://robot"
        );
    }

    function _open(uint256 authorized) private returns (uint256 rentalId) {
        vm.prank(operator);
        rentalId = manager.startRental(robotId, renter, authorized, 10_000, keccak256("hold"));
    }

    function test_startingARentalReservesTheRobot() public {
        uint256 rentalId = _open(21_580_000);

        RentalManager.Rental memory rental = manager.getRental(rentalId);
        assertEq(rental.renter, renter);
        assertEq(rental.owner, owner);
        assertEq(rental.authorizedAmount, 21_580_000);
        assertEq(uint8(registry.statusOf(robotId)), uint8(RobotRegistry.RobotStatus.Rented));
    }

    function test_onlyTheOperatorMayOpenARental() public {
        vm.prank(stranger);
        vm.expectRevert(RentalManager.NotSettlementOperator.selector);
        manager.startRental(robotId, renter, 1e6, 10_000, bytes32(0));
    }

    function test_surgeBelowOneIsRejected() public {
        vm.prank(operator);
        vm.expectRevert(RentalManager.SurgeOutOfRange.selector);
        manager.startRental(robotId, renter, 1e6, 9_999, bytes32(0));
    }

    function test_theMeterCannotGoBackwards() public {
        uint256 rentalId = _open(21_580_000);

        vm.prank(operator);
        manager.recordMeter(rentalId, 6, 3);

        vm.prank(operator);
        vm.expectRevert(RentalManager.MeterWentBackwards.selector);
        manager.recordMeter(rentalId, 5, 3);
    }

    function test_settlementSplitsTheFareAndFreesTheRobot() public {
        uint256 rentalId = _open(21_580_000);

        vm.prank(operator);
        manager.completeRental(rentalId, 6, 3);

        vm.prank(operator);
        (uint256 platformFee, uint256 ownerPayout) = manager.settleRental(rentalId, 8_700_000, keccak256("settle"));

        // 15% of 8.70 is 1.305, which rounds to a whole cent so the receipt adds up.
        assertEq(platformFee, 1_310_000);
        assertEq(ownerPayout, 7_390_000);
        assertEq(platformFee + ownerPayout, 8_700_000);
        assertEq(uint8(registry.statusOf(robotId)), uint8(RobotRegistry.RobotStatus.Available));
    }

    function test_theSplitAlwaysSumsToTheFare(uint96 fare) public {
        vm.assume(fare > 0);

        (uint256 platformFee, uint256 ownerPayout) = manager.quoteSplit(fare);
        assertEq(platformFee + ownerPayout, fare);
        assertLe(platformFee, fare);
        assertEq(platformFee % manager.FEE_QUANTUM(), 0);
    }

    function test_aFareCannotExceedItsAuthorization() public {
        uint256 rentalId = _open(5_000_000);

        vm.prank(operator);
        manager.completeRental(rentalId, 60, 20);

        vm.prank(operator);
        vm.expectRevert(RentalManager.FareExceedsAuthorization.selector);
        manager.settleRental(rentalId, 5_000_001, bytes32(0));
    }

    function test_aRentalCannotBeSettledWhileStillRunning() public {
        uint256 rentalId = _open(5_000_000);

        vm.prank(operator);
        vm.expectRevert(RentalManager.WrongState.selector);
        manager.settleRental(rentalId, 1e6, bytes32(0));
    }

    function test_aRentalCannotBeSettledTwice() public {
        uint256 rentalId = _open(5_000_000);

        vm.startPrank(operator);
        manager.completeRental(rentalId, 4, 1);
        manager.settleRental(rentalId, 4_000_000, bytes32(0));

        vm.expectRevert(RentalManager.WrongState.selector);
        manager.settleRental(rentalId, 4_000_000, bytes32(0));
        vm.stopPrank();
    }

    function test_cancellingFreesTheRobotWithoutCountingACompletion() public {
        uint256 rentalId = _open(5_000_000);

        vm.prank(operator);
        manager.cancelRental(rentalId, "robot faulted");

        assertEq(uint8(registry.statusOf(robotId)), uint8(RobotRegistry.RobotStatus.Available));
        assertEq(registry.getRobot(robotId).completedRentals, 0);
        assertEq(uint8(manager.getRental(rentalId).state), uint8(RentalManager.RentalState.Cancelled));
    }

    function test_theFeeCannotBeRaisedAboveTheCap() public {
        vm.prank(admin);
        vm.expectRevert(RentalManager.FeeTooHigh.selector);
        manager.setPlatformFeeBps(3001);
    }
}
