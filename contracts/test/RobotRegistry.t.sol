// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RobotRegistry} from "../src/RobotRegistry.sol";

contract RobotRegistryTest is Test {
    RobotRegistry private registry;

    address private admin = address(0xA11CE);
    address private manager = address(0xB0B);
    address private owner = address(0xC0FFEE);
    address private stranger = address(0xDEAD);

    function setUp() public {
        registry = new RobotRegistry(admin);
        vm.prank(admin);
        registry.setRentalManager(manager);
    }

    function _rates() private pure returns (RobotRegistry.RateCard memory) {
        return RobotRegistry.RateCard({baseFare: 2e6, perMinute: 35e4, perTask: 6e5, minimumFare: 3e6});
    }

    function _list() private returns (uint256 robotId) {
        vm.prank(owner);
        robotId = registry.listRobot(RobotRegistry.RobotClass.Picking, _rates(), "ipfs://robot");
    }

    function test_listingMakesTheRobotAvailable() public {
        uint256 robotId = _list();

        RobotRegistry.Robot memory robot = registry.getRobot(robotId);
        assertEq(robot.owner, owner);
        assertEq(uint8(robot.status), uint8(RobotRegistry.RobotStatus.Available));
        assertEq(registry.availableByClass(RobotRegistry.RobotClass.Picking), 1);
    }

    function test_availabilityCountTracksRentals() public {
        uint256 robotId = _list();

        vm.prank(manager);
        registry.markRented(robotId);
        assertEq(registry.availableByClass(RobotRegistry.RobotClass.Picking), 0);

        vm.prank(manager);
        registry.markReturned(robotId, true);
        assertEq(registry.availableByClass(RobotRegistry.RobotClass.Picking), 1);
        assertEq(registry.getRobot(robotId).completedRentals, 1);
    }

    function test_onlyTheRentalManagerMayClaimCapacity() public {
        uint256 robotId = _list();

        vm.prank(stranger);
        vm.expectRevert(RobotRegistry.NotRentalManager.selector);
        registry.markRented(robotId);
    }

    function test_aRentedRobotCannotBePulledMidRental() public {
        uint256 robotId = _list();

        vm.prank(manager);
        registry.markRented(robotId);

        vm.prank(owner);
        vm.expectRevert(RobotRegistry.InvalidStatusTransition.selector);
        registry.setAvailability(robotId, false);

        vm.prank(owner);
        vm.expectRevert(RobotRegistry.InvalidStatusTransition.selector);
        registry.delistRobot(robotId);
    }

    function test_maintenanceRemovesTheRobotFromTheAvailablePool() public {
        uint256 robotId = _list();

        vm.prank(owner);
        registry.setAvailability(robotId, false);

        assertEq(registry.availableByClass(RobotRegistry.RobotClass.Picking), 0);
        assertEq(uint8(registry.statusOf(robotId)), uint8(RobotRegistry.RobotStatus.Maintenance));
    }

    function test_onlyTheOwnerMayChangeTheRateCard() public {
        uint256 robotId = _list();

        vm.prank(stranger);
        vm.expectRevert(RobotRegistry.NotRobotOwner.selector);
        registry.updateRateCard(robotId, _rates());
    }

    function test_aRateCardMustChargeSomething() public {
        RobotRegistry.RateCard memory empty =
            RobotRegistry.RateCard({baseFare: 0, perMinute: 0, perTask: 0, minimumFare: 0});

        vm.prank(owner);
        vm.expectRevert(RobotRegistry.InvalidRateCard.selector);
        registry.listRobot(RobotRegistry.RobotClass.Picking, empty, "ipfs://robot");
    }

    function test_unknownRobotsRevert() public {
        vm.expectRevert(RobotRegistry.UnknownRobot.selector);
        registry.getRobot(99);
    }
}
