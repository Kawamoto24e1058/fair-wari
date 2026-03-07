export type PaymentMethod = 'Cash' | 'PayPay';
export type RoundMode = 'down' | 'up' | 'nearest' | 'none';

export interface Participant {
    id: string;
    name: string;
    paymentMethod: PaymentMethod;
    paypayId?: string; // PayPay Send Link / ID
}

export interface EventParticipation {
    participantId: string;
    weight: number;
    fixedAdjustment: number; // Positive means extra payment, negative means discount
}

export interface ExpenseEvent {
    id: string;
    title: string;
    amount: number;
    payerId: string;
    participations: EventParticipation[];
}

export interface AppState {
    participants: Participant[];
    events: ExpenseEvent[];
    roundMode: RoundMode;
    hostId?: string;
}

export interface Transaction {
    fromId: string;
    fromName: string;
    toId: string;
    toName: string;
    amount: number;
    method: PaymentMethod;
    toPaypayId?: string;
}

export interface BalanceResult {
    participantId: string;
    name: string;
    netBalance: number; // final float balance
    roundedBalance: number; // Used for transactions
    paymentMethod: PaymentMethod;
}

export interface CalculationResult {
    balances: BalanceResult[];
    transactions: Transaction[];
    hostAbsorbedAmount: number;
}

export function calculateNetBalances(state: AppState): CalculationResult {
    const { participants, events, roundMode, hostId } = state;
    if (participants.length === 0 || !hostId) return { balances: [], transactions: [], hostAbsorbedAmount: 0 };

    const host = participants.find(p => p.id === hostId);
    if (!host) return { balances: [], transactions: [], hostAbsorbedAmount: 0 };

    // 1. Calculate the exact mathematical burden for each participant based purely on Tab 1 Events.
    // In the new Numpad system, events always have payerId === hostId.
    // The "burden" (what they owe) is calculated by distributing the event amount over its participations.
    const exactBurdens: Record<string, number> = {};
    participants.forEach((p) => {
        exactBurdens[p.id] = 0;
    });

    for (const event of events) {
        const totalFixed = event.participations.reduce((sum, p) => sum + p.fixedAdjustment, 0);
        const remainingAmount = event.amount - totalFixed;

        const activeParticipations = event.participations.filter((p) => p.weight > 0 && exactBurdens[p.participantId] !== undefined);
        const totalWeight = activeParticipations.reduce((sum, p) => sum + p.weight, 0);

        for (const p of event.participations) {
            if (exactBurdens[p.participantId] === undefined) continue;
            let share = p.fixedAdjustment;
            if (p.weight > 0 && totalWeight > 0) {
                share += remainingAmount * (p.weight / totalWeight);
            }
            exactBurdens[p.participantId] += share;
        }
    }

    // 2. Apply rounding to the users' exact burdens based on the roundMode if they are Cash users.
    let hostAbsorbedAmount = 0; // Negative means the host lost money due to rounding, positive means host gained.
    const balances: BalanceResult[] = participants.map((p) => {
        const exactBurden = exactBurdens[p.id] ?? 0;
        let finalBurdenToPay = exactBurden;

        if (p.paymentMethod === 'Cash' && p.id !== hostId) {
            if (roundMode === 'down') {
                // Down: Guest pays less. E.g. 1999 -> 1900.
                finalBurdenToPay = Math.floor(exactBurden / 100) * 100;
            } else if (roundMode === 'up') {
                // Up: Guest pays more. E.g. 1901 -> 2000.
                finalBurdenToPay = Math.ceil(exactBurden / 100) * 100;
            } else if (roundMode === 'none') {
                finalBurdenToPay = Math.round(exactBurden); // 1 yen precision 
            } else {
                // Nearest
                finalBurdenToPay = Math.round(exactBurden / 100) * 100;
            }
        } else {
            // PayPay & Host always round to nearest 1-yen exact
            finalBurdenToPay = Math.round(exactBurden);
        }

        // Calculate how much the host is absorbing/gaining from this user's rounding.
        if (p.id !== hostId) {
            hostAbsorbedAmount += (exactBurden - finalBurdenToPay);
        }

        return {
            participantId: p.id,
            name: p.name,
            netBalance: -exactBurden, // Historically, negative meant "owes". We keep semantics for potential UI reuse safely.
            roundedBalance: -finalBurdenToPay,
            paymentMethod: p.paymentMethod
        };
    });

    // We only care about how much the Host had to *pay out of pocket* (absorb positive difference)
    const displayHostAbsorbedAmount = hostAbsorbedAmount > 0 ? hostAbsorbedAmount : 0;

    // 3. Generate 1:1 Transactions from everyone to the Host
    const transactions: Transaction[] = [];

    for (const bal of balances) {
        if (bal.participantId === hostId) continue;
        const amountOwed = Math.abs(bal.roundedBalance);

        if (amountOwed > 0) {
            transactions.push({
                fromId: bal.participantId,
                fromName: bal.name,
                toId: host.id,
                toName: host.name,
                amount: amountOwed,
                method: bal.paymentMethod,
                toPaypayId: host.paypayId,
            });
        }
    }

    return { balances, transactions, hostAbsorbedAmount: displayHostAbsorbedAmount };
}
