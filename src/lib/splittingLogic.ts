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
    const { participants, events, roundMode } = state;
    if (participants.length === 0 || events.length === 0) return { balances: [], transactions: [], hostAbsorbedAmount: 0 };

    // 1. Calculate raw balances (Positive = Receives back, Negative = Owes)
    const rawBalances: Record<string, number> = {};
    const getParticipant = (id: string) => participants.find((p) => p.id === id);

    participants.forEach((p) => {
        rawBalances[p.id] = 0;
    });

    for (const event of events) {
        if (!getParticipant(event.payerId)) continue;

        rawBalances[event.payerId] += event.amount;

        const totalFixed = event.participations.reduce((sum, p) => sum + p.fixedAdjustment, 0);
        const remainingAmount = event.amount - totalFixed;

        const activeParticipations = event.participations.filter((p) => p.weight > 0 && getParticipant(p.participantId));
        const totalWeight = activeParticipations.reduce((sum, p) => sum + p.weight, 0);

        for (const p of event.participations) {
            if (!getParticipant(p.participantId)) continue;
            let share = p.fixedAdjustment;
            if (p.weight > 0 && totalWeight > 0) {
                share += remainingAmount * (p.weight / totalWeight);
            }
            rawBalances[p.participantId] -= share;
        }
    }

    // 2. Adjust Cash users' balances
    let cashDifference = 0;
    const adjustedBalances = participants.map((p) => {
        const balance = rawBalances[p.id] ?? 0;

        if (p.paymentMethod === 'Cash') {
            let rounded = balance;
            const absBal = Math.abs(balance);
            const sign = Math.sign(balance);

            if (roundMode === 'down') {
                // Cash favors cash user: pays less, receives less
                rounded = sign * Math.floor(absBal / 100) * 100;
            } else if (roundMode === 'up') {
                // Cash disfavors cash user: pays more, receives more
                rounded = sign * Math.ceil(absBal / 100) * 100;
            } else if (roundMode === 'none') {
                // No rounding, 1 yen precision
                rounded = Math.round(balance);
            } else {
                rounded = Math.round(balance / 100) * 100;
            }

            cashDifference += balance - rounded;
            return { p, balance: rounded, origBalance: balance };
        }
        return { p, balance, origBalance: balance };
    });

    // 3. Distribute cash difference to Host or PayPay users
    let hostAbsorbedAmount = 0;
    const paypayUsers = adjustedBalances.filter((x) => x.p.paymentMethod === 'PayPay');
    if (Math.abs(cashDifference) > 0.001) {
        let takenHitByHost = false;
        if (state.hostId) {
            const hostObj = adjustedBalances.find((x) => x.p.id === state.hostId);
            if (hostObj) {
                hostObj.balance += cashDifference;
                // If cashDifference is negative, cash user paid less, so host absorbs the difference (loss)
                hostAbsorbedAmount = cashDifference < 0 ? -cashDifference : 0;
                takenHitByHost = true;
            }
        }

        if (!takenHitByHost) {
            if (paypayUsers.length > 0) {
                const diffPerPerson = cashDifference / paypayUsers.length;
                paypayUsers.forEach((x) => {
                    x.balance += diffPerPerson;
                });
            } else if (adjustedBalances.length > 0) {
                adjustedBalances[0].balance += cashDifference;
            }
        }
    }

    // 4. Round to 1 yen
    let sum = 0;
    adjustedBalances.forEach((x) => {
        x.balance = Math.round(x.balance);
        sum += x.balance;
    });

    let error = sum;
    let index = 0;
    while (error !== 0 && index < adjustedBalances.length * 10) {
        let tgt = adjustedBalances[index % adjustedBalances.length];
        if (paypayUsers.length > 0 && tgt.p.paymentMethod !== 'PayPay') {
            index++;
            continue;
        }
        if (error > 0) {
            tgt.balance -= 1;
            error -= 1;
        } else if (error < 0) {
            tgt.balance += 1;
            error += 1;
        }
        index++;
    }

    const balances: BalanceResult[] = adjustedBalances.map((x) => ({
        participantId: x.p.id,
        name: x.p.name,
        netBalance: x.origBalance,
        roundedBalance: x.balance,
        paymentMethod: x.p.paymentMethod
    }));

    // 5. Debt Simplification
    const generators = adjustedBalances.filter((x) => x.balance > 0).map((x) => ({ ...x, amount: x.balance })).sort((a, b) => b.amount - a.amount);
    const consumers = adjustedBalances.filter((x) => x.balance < 0).map((x) => ({ ...x, amount: -x.balance })).sort((a, b) => b.amount - a.amount);

    const transactions: Transaction[] = [];
    let g = 0,
        c = 0;

    while (g < generators.length && c < consumers.length) {
        let gen = generators[g];
        let con = consumers[c];

        let amount = Math.min(gen.amount, con.amount);

        if (amount > 0) {
            transactions.push({
                fromId: con.p.id,
                fromName: con.p.name,
                toId: gen.p.id,
                toName: gen.p.name,
                amount: amount,
                method: con.p.paymentMethod,
                toPaypayId: gen.p.paypayId
            });
        }

        gen.amount -= amount;
        con.amount -= amount;

        if (gen.amount === 0) g++;
        if (con.amount === 0) c++;
    }

    return { balances, transactions, hostAbsorbedAmount };
}
