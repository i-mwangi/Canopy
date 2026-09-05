export type RobotClass = 'Picking' | 'Packing' | 'Delivery';

export type RobotStatus = 'Unlisted' | 'Available' | 'Rented' | 'Maintenance';

export type RateCard = {
    baseFare: string;
    perMinute: string;
    perTask: string;
    minimumFare: string;
};

export type Move = { step: number; label: string };

export type TaskLeg = {
    name: string;
    from: string;
    to: string;
    description: string;
    moves: [Move, Move];
};

export type Robot = {
    id: string;
    owner: string;
    class: RobotClass;
    leg: TaskLeg;
    status: RobotStatus;
    rates: RateCard;
    completedRentals: number;
    metadataUri: string;
};

export type MeterReading = {
    meteredMinutes: number;
    tasksCompleted: number;
};

export type RentalStatus = 'active' | 'completed' | 'settled' | 'cancelled';

export type Rental = {
    id: string;
    onChainId?: string;
    robotId: string;
    class: RobotClass;
    leg: TaskLeg;
    status: RentalStatus;
    surgeBps: number;
    authorized: string;
    meter: MeterReading;
    fare?: string;
    platformFee?: string;
    ownerPayout?: string;
    settlementRef?: string;
    startedAt: number;
    endedAt?: number;
};

export type Quote = {
    robotId: string;
    surgeBps: number;
    estimatedFare: string;
    platformFee: string;
    ownerPayout: string;
    authorizationHold: string;
    maxBillableMinutes: number;
    perMinute: string;
};

export type Balance = {
    available: string;
    held: string;
    total: string;
};

export type StatementEntry = {
    id: string;
    kind: string;
    amount: string;
    heldDelta: string;
    rentalId?: string;
    memo?: string;
    createdAt: number;
};

export type RentalEventKind =
    | 'rental_started'
    | 'robot_assigned'
    | 'meter_recorded'
    | 'rental_completed'
    | 'fare_captured'
    | 'payout_transferred'
    | 'fee_transferred'
    | 'hold_released'
    | 'rental_settled'
    | 'rental_cancelled';

export type RentalPhase = 'authorize' | 'work' | 'settle';

export type RentalEvent = {
    id: number;
    kind: RentalEventKind;
    label: string;
    detail?: string;
    amount?: string;
    transactionId?: string;
    txHash?: string;
    phase: RentalPhase;
    createdAt: number;
};
