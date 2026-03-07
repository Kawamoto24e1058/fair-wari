<script lang="ts">
    import {
        calculateNetBalances,
        type Participant,
        type ExpenseEvent,
        type RoundMode,
        type Transaction,
        type BalanceResult,
        type AppState,
    } from "$lib/splittingLogic";
    import { onMount, tick, onDestroy } from "svelte";
    import { page } from "$app/stores";
    import { db } from "$lib/firebase/firebase";
    import {
        doc,
        onSnapshot,
        updateDoc,
        getDoc,
        deleteDoc,
    } from "firebase/firestore";
    import QRCode from "qrcode";

    // Driver.js global type definition
    declare var window: any;

    let roomId = $page.params.roomId;

    let participants = $state<Participant[]>([]);
    let events = $state<ExpenseEvent[]>([]);
    let roundMode = $state<RoundMode>("nearest");

    let balances = $state<BalanceResult[]>([]);
    let transactions = $state<Transaction[]>([]);
    let settlements = $state<Record<string, boolean>>({});

    let isInitialized = $state(false);
    let myParticipantId = $state<string | null>(null);
    let isHost = $state(false);
    let currentHostId = $state<string | null>(null);
    let hostAbsorbedAmount = $state<number>(0);

    let activeTab = $state<"calc" | "settle">("calc");
    let currentAmount = $state("");

    let unpaidCount = $derived(
        transactions.filter((t) => !settlements[t.fromId]).length,
    );

    let showIdentityModal = $state(false);
    let newParticipantName = $state("");
    let newParticipantMethod = $state<"PayPay" | "Cash">("PayPay");

    let showQrModal = $state(false);
    let qrDataUrl = $state("");

    let toastMessage = $state("");
    let showToast = $state(false);

    let unsubscribe: (() => void) | undefined;

    // Will be defined at the bottom, declared here for TS hoisting
    let startTutorial: () => void;

    onMount(() => {
        const savedIdentity = localStorage.getItem(`room_${roomId}_identity`);
        if (savedIdentity) {
            try {
                const parsed = JSON.parse(savedIdentity);
                myParticipantId = parsed.participantId;
                isHost = parsed.isHost;
            } catch (e) {
                console.error("Local identity parse error", e);
            }
        }

        const roomRef = doc(db, "rooms", roomId as string);

        getDoc(roomRef).then((snap) => {
            if (snap.exists()) {
                const parts = snap.data().state?.participants || [];

                // セッション維持の堅牢化：ローカルにIDがあっても、Firestore側に存在しない場合は削除されたとみなしてリセット
                if (
                    myParticipantId &&
                    !parts.some((p: Participant) => p.id === myParticipantId)
                ) {
                    myParticipantId = null;
                    isHost = false;
                    localStorage.removeItem(`room_${roomId}_identity`);
                }

                if (parts.length === 0 && !myParticipantId) {
                    showIdentityModal = true;
                } else if (!myParticipantId) {
                    showIdentityModal = true;
                }
            }
        });

        unsubscribe = onSnapshot(roomRef, (snapshot) => {
            if (snapshot.exists()) {
                const data = snapshot.data();
                if (data.state) {
                    participants = data.state.participants || [];
                    events = data.state.events || [];
                    roundMode = data.state.roundMode || "nearest";
                }
                if (data.settlements) {
                    settlements = data.settlements || {};
                }
                if (data.hostId) {
                    currentHostId = data.hostId;
                    if (myParticipantId) {
                        isHost = data.hostId === myParticipantId;
                        localStorage.setItem(
                            `room_${roomId}_identity`,
                            JSON.stringify({
                                participantId: myParticipantId,
                                isHost: isHost,
                            }),
                        );
                    }
                }
                isInitialized = true;
                updateCalculation();
            } else {
                alert(
                    "ルームは削除されました（または存在しません）。トップページに戻ります。",
                );
                window.location.href = "/";
            }
        });

        // Initialize driver.js tutorial if not seen
        setTimeout(() => {
            if (!localStorage.getItem("hasSeenTutorial")) {
                startTutorial();
            }
        }, 1000); // Small delay to let DOM paint first
    });

    onDestroy(() => {
        if (unsubscribe) unsubscribe();
    });

    async function saveStateToFirebase(extraData = {}) {
        if (!isInitialized) return;
        const roomRef = doc(db, "rooms", roomId as string);
        await updateDoc(roomRef, {
            state: { participants, events, roundMode },
            settlements,
            ...extraData,
        });
    }

    function updateCalculation() {
        if (!isInitialized) return;
        const state: AppState = {
            participants,
            events,
            roundMode,
            hostId: currentHostId || undefined,
        };
        const res = calculateNetBalances(state);
        balances = res.balances;
        transactions = res.transactions;
        hostAbsorbedAmount = res.hostAbsorbedAmount;
    }

    function saveAndRecalculate() {
        updateCalculation();
        // Since we want immediate UI feedback and fast saves
        if (isHost) {
            saveStateToFirebase();
        }
    }

    function joinAsNewParticipant() {
        if (!newParticipantName.trim()) return alert("名前を入力してください");

        const id = Date.now().toString();
        const newP: Participant = {
            id,
            name: newParticipantName,
            paymentMethod: newParticipantMethod,
            paypayId: "",
            amount: 0,
        };
        participants.push(newP);

        events.forEach((e) => {
            e.participations.push({
                participantId: id,
                weight: 1,
                fixedAdjustment: 0,
            });
        });

        myParticipantId = id;
        localStorage.setItem(
            `room_${roomId}_identity`,
            JSON.stringify({
                participantId: id,
                isHost: isHost,
            }),
        );
        showIdentityModal = false;

        if (participants.length === 1) {
            saveStateToFirebase({ hostId: id });
        } else {
            saveStateToFirebase();
        }
    }

    function joinAsExistingParticipant(pid: string) {
        myParticipantId = pid;
        localStorage.setItem(
            `room_${roomId}_identity`,
            JSON.stringify({
                participantId: pid,
                isHost: false,
            }),
        );
        showIdentityModal = false;
    }

    function toggleSettlement(pid: string) {
        if (myParticipantId !== pid && !isHost) return;
        settlements[pid] = !settlements[pid];
        saveStateToFirebase();
    }

    async function transferHost(newHostId: string) {
        if (!isHost) return;
        if (
            !confirm(
                "本当に幹事の権限をこのユーザーに移譲しますか？\n（移譲後はあなたも参加者になります）",
            )
        )
            return;

        isHost = false;
        const roomRef = doc(db, "rooms", roomId as string);
        await updateDoc(roomRef, { hostId: newHostId });
    }

    async function deleteRoom() {
        if (!isHost) return;
        if (
            !confirm(
                "本当にこの精算を終了してルームを完全に削除しますか？\n（すべてのデータが復元できなくなります）",
            )
        )
            return;

        const roomRef = doc(db, "rooms", roomId as string);
        await deleteDoc(roomRef);
    }

    function showToastNotification(message: string) {
        toastMessage = message;
        showToast = true;
        setTimeout(() => {
            showToast = false;
        }, 3000);
    }

    async function handlePayPayClick(
        fromId: string,
        amount: number,
        paypayUrl: string,
    ) {
        if (!paypayUrl) {
            return alert(
                "幹事のPayPay受取リンクが設定されていません。最終精算タブ上部で設定してください。",
            );
        }

        if (myParticipantId === fromId) {
            settlements[fromId] = true;
            saveStateToFirebase();
        }

        try {
            // Copy ONLY the digits (e.g. 1000 instead of "1,000円")
            const amountStr = Math.round(amount).toString();
            await navigator.clipboard.writeText(amountStr);
            showToastNotification(
                `¥${amount.toLocaleString()} をコピーしました！PayPayで金額欄にペーストしてください。`,
            );
        } catch (err) {
            console.error("Failed to copy amount", err);
            showToastNotification("別タブでPayPayを開きます。");
        }

        // Give the toast a tiny fraction of a second to render
        setTimeout(() => {
            window.open(paypayUrl, "_blank", "noopener,noreferrer");
        }, 150);
    }

    function handleNumpad(key: string) {
        if (key === "C") {
            currentAmount = "";
        } else if (key === "00") {
            if (currentAmount !== "" && currentAmount !== "0") {
                currentAmount += "00";
            }
        } else {
            if (currentAmount === "0") {
                currentAmount = key;
            } else {
                currentAmount += key;
            }
        }
        if (currentAmount.length > 7) {
            currentAmount = currentAmount.slice(0, 7);
        }
    }

    function addAmountToMyself() {
        if (!currentAmount) return;
        const amount = parseInt(currentAmount, 10);
        if (isNaN(amount) || amount <= 0) return;
        if (!myParticipantId)
            return alert(
                "ユーザーが特定できません。もう一度参加してください。",
            );

        const targetP = participants.find((p) => p.id === myParticipantId);
        if (targetP) {
            targetP.amount = (targetP.amount || 0) + amount;
            currentAmount = "";
            saveAndRecalculate();
            showToastNotification(
                `自分の負担に ¥${amount.toLocaleString()} を追加しました`,
            );
        }
    }

    function addAmountToAll() {
        if (!currentAmount) return;
        const amount = parseInt(currentAmount, 10);
        if (isNaN(amount) || amount <= 0) return;
        if (participants.length === 0) return alert("メンバーがいません");

        const perPerson = Math.floor(amount / participants.length);
        participants.forEach((p) => {
            p.amount = (p.amount || 0) + perPerson;
        });

        currentAmount = "";
        saveAndRecalculate();
        showToastNotification(
            `各員に ¥${perPerson.toLocaleString()} ずつ追加しました`,
        );
    }

    function getParticipantBurden(pid: string) {
        let burden = 0;
        for (const e of events) {
            const sumWeights = e.participations.reduce(
                (s, p) => s + p.weight,
                0,
            );
            const sumFixed = e.participations.reduce(
                (s, p) => s + p.fixedAdjustment,
                0,
            );
            const ep = e.participations.find((p) => p.participantId === pid);
            if (ep) {
                if (sumWeights > 0) {
                    burden +=
                        (e.amount - sumFixed) * (ep.weight / sumWeights) +
                        ep.fixedAdjustment;
                } else {
                    burden += ep.fixedAdjustment;
                }
            }
        }
        return Math.round(burden);
    }

    async function generateQrCode() {
        try {
            qrDataUrl = await QRCode.toDataURL(window.location.href, {
                width: 300,
                margin: 2,
            });
            showQrModal = true;
        } catch (err) {
            console.error("QR Code generation failed", err);
        }
    }

    function addParticipant() {
        if (!isHost) return;
        const id = Date.now().toString();
        participants.push({
            id,
            name: `参加者${participants.length + 1}`,
            paymentMethod: "PayPay",
            paypayId: "",
            amount: 0,
        });
        events.forEach((e) => {
            e.participations.push({
                participantId: id,
                weight: 1,
                fixedAdjustment: 0,
            });
        });
        saveAndRecalculate();
    }

    function removeParticipant(id: string) {
        if (!isHost) return;
        participants = participants.filter((p) => p.id !== id);
        events.forEach((e) => {
            e.participations = e.participations.filter(
                (ep) => ep.participantId !== id,
            );
            if (e.payerId === id && participants.length > 0) {
                e.payerId = participants[0].id;
            }
        });
        saveAndRecalculate();
    }

    function addEvent() {
        if (!isHost) return;
        events.push({
            id: Date.now().toString(),
            title: `レシート ${events.length + 1}`,
            amount: 0,
            payerId: participants.length > 0 ? participants[0].id : "",
            participations: participants.map((p) => ({
                participantId: p.id,
                weight: 1,
                fixedAdjustment: 0,
            })),
        });
        saveAndRecalculate();
    }

    function removeEvent(id: string) {
        if (!isHost) return;
        events = events.filter((e) => e.id !== id);
        saveAndRecalculate();
    }

    async function copyShareUrl() {
        const url = window.location.href;
        try {
            await navigator.clipboard.writeText(url);
            alert(
                "このルームのURLをコピーしました！みんなにシェアしましょう。",
            );
        } catch (err) {
            alert("コピーに失敗しました。");
        }
    }

    startTutorial = function () {
        if (!window.driver) {
            console.warn("Driver.js not loaded yet, retrying in 500ms...");
            setTimeout(startTutorial, 500);
            return;
        }

        const driverObj = window.driver.js.driver({
            showProgress: true,
            animate: true,
            allowClose: true,
            doneBtnText: "よくわかりました",
            nextBtnText: "次へ",
            prevBtnText: "戻る",
            popoverClass: "driverjs-apple",
            onDestroyStarted: () => {
                localStorage.setItem("hasSeenTutorial", "true");
                driverObj.destroy();
            },
            steps: [
                {
                    popover: {
                        title: "最強の割り勘アプリへようこそ",
                        description:
                            "面倒な文字入力は一切不要。テンキーで金額を打つだけで、誰がいくら払うか自動で計算します。",
                        side: "over",
                        align: "center",
                    },
                },
                {
                    element: "#tutorial-tabs",
                    popover: {
                        title: "2つのモードを使い分け",
                        description:
                            "食事中は『注文メモ』で金額を足していき、帰る時は『最終精算』でPayPay送金を行います。",
                        side: "bottom",
                        align: "center",
                    },
                },
                {
                    element: "#tutorial-numpad",
                    popover: {
                        title: "電卓感覚で入力",
                        description:
                            "メニューの金額を打ち込んで、『自分の分』か『全員で割る』を選ぶだけです。",
                        side: "top",
                        align: "center",
                    },
                },
                {
                    element: "#tutorial-settle-tab",
                    popover: {
                        title: "幹事の準備",
                        description:
                            "こちらの『最終精算』タブの中に、幹事のPayPayマイコードURLを貼る欄があります。事前に入力しておきましょう。",
                        side: "bottom",
                        align: "center",
                    },
                },
            ],
        });

        // Switch to Tab 1 for numpad step visibility
        activeTab = "calc";
        setTimeout(() => driverObj.drive(), 100);
    };
</script>

<svelte:head>
    <title>最強の割り勘アプリ - ルーム</title>
    <link
        rel="stylesheet"
        href="https://cdn.jsdelivr.net/npm/driver.js@1.0.1/dist/driver.css"
    />
    <script
        src="https://cdn.jsdelivr.net/npm/driver.js@1.0.1/dist/driver.js.iife.js"
    ></script>
    <style>
        /* Apple-style Driver.js popover overrides */
        .driverjs-apple {
            background: #ffffff !important;
            color: #1f2937 !important;
            border-radius: 20px !important;
            box-shadow:
                0 20px 60px -10px rgba(0, 0, 0, 0.12),
                0 0 0 1px rgba(0, 0, 0, 0.04) !important;
            padding: 24px 24px 20px !important;
            max-width: 320px !important;
            font-family: inherit !important;
        }
        .driverjs-apple .driver-popover-title {
            font-size: 1.0625rem !important;
            font-weight: 800 !important;
            color: #111827 !important;
            margin-bottom: 8px !important;
            line-height: 1.4 !important;
            letter-spacing: -0.01em !important;
        }
        .driverjs-apple .driver-popover-description {
            font-size: 0.875rem !important;
            color: #6b7280 !important;
            line-height: 1.6 !important;
            font-weight: 500 !important;
        }
        .driverjs-apple .driver-popover-footer {
            margin-top: 18px !important;
            padding-top: 14px !important;
            border-top: 1px solid #f3f4f6 !important;
        }
        .driverjs-apple .driver-popover-progress-text {
            font-size: 0.75rem !important;
            font-weight: 700 !important;
            color: #9ca3af !important;
        }
        .driverjs-apple button.driver-popover-prev-btn,
        .driverjs-apple button.driver-popover-close-btn {
            background-color: #f3f4f6 !important;
            color: #6b7280 !important;
            border: none !important;
            border-radius: 10px !important;
            padding: 7px 14px !important;
            font-size: 0.8125rem !important;
            font-weight: 700 !important;
            text-shadow: none !important;
            box-shadow: none !important;
        }
        .driverjs-apple button.driver-popover-next-btn {
            background-color: #4f46e5 !important;
            color: #ffffff !important;
            border: none !important;
            border-radius: 10px !important;
            padding: 7px 14px !important;
            font-size: 0.8125rem !important;
            font-weight: 700 !important;
            text-shadow: none !important;
            box-shadow: 0 2px 8px rgba(79, 70, 229, 0.3) !important;
        }
        .driverjs-apple button.driver-popover-next-btn:hover {
            background-color: #4338ca !important;
        }
        .driverjs-apple .driver-popover-close-btn {
            background: transparent !important;
            color: #9ca3af !important;
            padding: 4px !important;
        }
    </style>
</svelte:head>

<!-- QR Code Modal -->
{#if showQrModal}
    <div
        class="fixed inset-0 bg-black/50 z-[60] flex flex-col items-center justify-center p-4 transition-opacity"
        onclick={() => (showQrModal = false)}
        aria-hidden="true"
    >
        <div
            class="bg-white rounded-3xl p-6 sm:p-8 max-w-sm w-full shadow-2xl flex flex-col items-center gap-4"
            onclick={(e) => e.stopPropagation()}
            aria-hidden="true"
        >
            <h2 class="text-xl font-bold text-gray-800 text-center">
                このルームへ招待
            </h2>
            <p class="text-sm text-gray-500 text-center">
                以下のQRコードをスキャンして<br />ルームに参加してください。
            </p>
            {#if qrDataUrl}
                <img
                    src={qrDataUrl}
                    alt="Room QR Code"
                    class="w-full h-auto rounded-xl border border-gray-100 p-2"
                />
            {/if}
            <button
                onclick={() => (showQrModal = false)}
                class="mt-4 w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-3 px-4 rounded-xl transition-colors"
                >閉じる</button
            >
        </div>
    </div>
{/if}

<!-- Toast Notification -->
{#if showToast}
    <div
        class="fixed bottom-6 left-1/2 transform -translate-x-1/2 bg-gray-900 text-white px-6 py-3 rounded-full shadow-lg z-[70] transition-opacity animate-fade-in flex items-center gap-3 text-sm font-bold w-max max-w-[90vw]"
    >
        <svg
            class="w-5 h-5 text-emerald-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            ><path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            ></path></svg
        >
        {toastMessage}
    </div>
{/if}

<!-- Identity Modal -->
{#if showIdentityModal}
    <div
        class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
    >
        <div class="bg-white rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl">
            <h2 class="text-xl font-bold mb-6 text-gray-800 text-center">
                {isHost ? "幹事としてルームを始めます" : "ルームに参加します"}
            </h2>

            {#if participants.length > 0 && !isHost}
                <div class="mb-6">
                    <p class="text-sm text-gray-600 font-bold mb-3">
                        すでに登録されているメンバーから選ぶ
                    </p>
                    <div class="grid grid-cols-2 gap-2">
                        {#each participants as p}
                            <button
                                onclick={() => joinAsExistingParticipant(p.id)}
                                class="py-2 px-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-bold text-gray-700 hover:bg-gray-100 hover:border-gray-300 transition-colors"
                            >
                                {p.name}
                            </button>
                        {/each}
                    </div>
                </div>

                <div class="relative flex items-center py-4">
                    <div class="flex-grow border-t border-gray-200"></div>
                    <span
                        class="flex-shrink-0 mx-4 text-gray-400 text-xs font-bold uppercase"
                        >または</span
                    >
                    <div class="flex-grow border-t border-gray-200"></div>
                </div>
            {/if}

            <div>
                <p class="text-sm text-gray-600 font-bold mb-3">
                    新しくメンバーを追加して参加する
                </p>
                <input
                    type="text"
                    bind:value={newParticipantName}
                    placeholder="あなたの名前"
                    class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-500 mb-3 text-sm font-bold"
                />

                <div class="flex items-center rounded-xl bg-gray-200 p-1 mb-6">
                    <button
                        onclick={() => (newParticipantMethod = "PayPay")}
                        class="flex-1 py-2 text-sm font-bold rounded-lg transition-all {newParticipantMethod ===
                        'PayPay'
                            ? 'bg-white text-[#FF0033] shadow-sm'
                            : 'text-gray-500'}">PayPay派</button
                    >
                    <button
                        onclick={() => (newParticipantMethod = "Cash")}
                        class="flex-1 py-2 text-sm font-bold rounded-lg transition-all {newParticipantMethod ===
                        'Cash'
                            ? 'bg-white text-green-600 shadow-sm'
                            : 'text-gray-500'}">現金派</button
                    >
                </div>

                <button
                    onclick={joinAsNewParticipant}
                    class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 px-4 rounded-xl shadow-md transition-colors"
                >
                    この名前で参加する
                </button>
            </div>
        </div>
    </div>
{/if}

<main class="min-h-screen bg-gray-50 pb-20">
    <header
        class="bg-white border-b border-gray-200 sticky top-0 z-10 shadow-sm"
    >
        <div
            class="max-w-7xl mx-auto px-4 py-4 md:py-5 flex justify-between items-center"
        >
            <div>
                <h1
                    class="text-2xl md:text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-primary-600 to-indigo-600 tracking-tight flex items-center gap-2"
                >
                    最強の割り勘アプリ
                    {#if isHost}
                        <span
                            class="px-2 py-0.5 bg-indigo-100 text-indigo-700 text-[10px] font-black uppercase rounded-lg shadow-sm"
                            >Host</span
                        >
                    {:else if myParticipantId}
                        <span
                            class="px-2 py-0.5 bg-gray-100 text-gray-600 text-[10px] font-black uppercase rounded-lg shadow-sm"
                            >Guest</span
                        >
                    {/if}
                </h1>
                <p
                    class="text-xs md:text-sm text-gray-500 font-medium mt-1 flex items-center gap-2"
                >
                    リアルタイム共有ルーム
                    <button
                        onclick={startTutorial}
                        class="px-2 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-500 text-[10px] font-bold rounded-md transition-colors flex items-center gap-1 shadow-sm"
                    >
                        <svg
                            class="w-3 h-3"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            ><path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2.5"
                                d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                            ></path></svg
                        >
                        ガイドを見る
                    </button>
                </p>
            </div>
            <div class="flex items-center gap-2">
                <button
                    onclick={generateQrCode}
                    class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 px-3 py-2 sm:px-4 rounded-xl text-sm font-bold shadow-sm transition-colors flex items-center gap-2"
                >
                    <svg
                        class="w-4 h-4 sm:w-5 sm:h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        ><path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm14 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
                        ></path></svg
                    >
                    <span class="hidden sm:inline">QRコード</span>
                </button>
                <button
                    onclick={copyShareUrl}
                    class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 px-3 py-2 sm:px-4 rounded-xl text-sm font-bold shadow-sm transition-colors flex items-center gap-2"
                >
                    <svg
                        class="w-4 h-4 sm:w-5 sm:h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        ><path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                        ></path></svg
                    >
                    <span class="hidden sm:inline">URLを共有</span>
                </button>
            </div>
        </div>
    </header>

    <!-- Tabs Container -->
    <div
        id="tutorial-tabs"
        class="bg-white border-b border-gray-200 sticky top-[73px] md:top-[77px] z-[5] mb-6 shadow-sm"
    >
        <div class="max-w-3xl mx-auto flex">
            <button
                onclick={() => (activeTab = "calc")}
                class="flex-1 py-3 text-center font-bold text-sm transition-colors border-b-[3px] {activeTab ===
                'calc'
                    ? 'border-primary-600 text-primary-600'
                    : 'border-transparent text-gray-500 hover:bg-gray-50'} flex flex-col items-center justify-center gap-1"
            >
                <svg
                    class="w-5 h-5 mb-0.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    ><path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2.5"
                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                    ></path></svg
                >
                注文メモ
            </button>
            <button
                id="tutorial-settle-tab"
                onclick={() => (activeTab = "settle")}
                class="flex-1 py-3 text-center font-bold text-sm transition-colors border-b-[3px] {activeTab ===
                'settle'
                    ? 'border-primary-600 text-primary-600'
                    : 'border-transparent text-gray-500 hover:bg-gray-50'} flex flex-col items-center justify-center gap-1"
            >
                <svg
                    class="w-5 h-5 mb-0.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    ><path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2.5"
                        d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    ></path></svg
                >
                最終精算
            </button>
        </div>
    </div>

    <!-- TAB 1: CALC -->
    <div
        class="{activeTab === 'calc'
            ? 'block'
            : 'hidden'} max-w-3xl mx-auto px-4 relative min-h-screen"
    >
        <section
            class="bg-white rounded-3xl shadow-sm border border-gray-200 p-6 mb-80"
        >
            <h2
                class="text-xl font-bold mb-5 flex items-center justify-between"
            >
                <span class="text-gray-800">メンバーの現在負担額</span>
                <span
                    class="text-sm font-medium text-gray-500 bg-gray-100 px-3 py-1 rounded-full"
                    >合計: ¥{events
                        .reduce((acc, ev) => acc + ev.amount, 0)
                        .toLocaleString()}</span
                >
            </h2>
            <div class="space-y-3">
                {#each balances as r}
                    <div
                        class="bg-gray-50 border border-gray-100 rounded-2xl p-4 flex justify-between items-center relative transition-shadow"
                    >
                        {#if r.participantId === myParticipantId}
                            <div
                                class="absolute -top-2 left-4 bg-indigo-500 text-white text-[10px] font-black px-2 py-0.5 rounded-full shadow-sm z-10 w-fit"
                            >
                                YOURS
                            </div>
                        {/if}
                        <div class="flex items-center gap-3">
                            <div
                                class="w-10 h-10 rounded-full bg-white flex items-center justify-center font-bold text-gray-400 shadow-sm border border-gray-200 text-sm"
                            >
                                {r.name.substring(0, 2)}
                            </div>
                            <div class="font-bold text-gray-800 text-base">
                                {r.name}
                            </div>
                        </div>
                        <div class="text-right flex-shrink-0">
                            <div
                                class="text-[10px] text-gray-400 font-bold mb-0.5 uppercase tracking-wide"
                            >
                                負担額
                            </div>
                            <div
                                class="text-xl font-black text-gray-900 border-b-2 border-indigo-200 inline-block min-w-[80px]"
                            >
                                ¥{getParticipantBurden(
                                    r.participantId,
                                ).toLocaleString()}
                            </div>
                        </div>
                    </div>
                {/each}
                {#if balances.length === 0}
                    <p class="text-sm text-gray-400 text-center py-8">
                        まだメンバーがいません
                    </p>
                {/if}
            </div>
        </section>

        <!-- Fixed Numpad -->
        <div
            class="fixed bottom-0 left-0 right-0 bg-white shadow-[0_-10px_40px_rgba(0,0,0,0.08)] rounded-t-[2rem] border-t border-gray-100 p-5 z-40 pb-6"
        >
            <div id="tutorial-numpad" class="max-w-3xl mx-auto">
                <!-- Display -->
                <div
                    class="bg-gray-50 rounded-2xl p-4 mb-4 text-right overflow-hidden border border-gray-200 shadow-inner flex justify-between items-center"
                >
                    <span class="text-gray-400 font-bold text-sm">入力金額</span
                    >
                    <span
                        class="text-4xl font-black text-gray-800 tracking-tighter truncate leading-none"
                        >¥{currentAmount
                            ? parseInt(currentAmount, 10).toLocaleString()
                            : "0"}</span
                    >
                </div>

                <!-- Action Buttons -->
                <div class="grid grid-cols-2 gap-3 mb-4">
                    <button
                        onclick={addAmountToMyself}
                        class="bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-bold py-3.5 rounded-2xl flex flex-col items-center justify-center gap-1.5 active:scale-95 transition-all text-sm shadow-sm group"
                    >
                        <svg
                            class="w-6 h-6 text-emerald-500 mb-0.5 group-active:-translate-y-1 transition-transform"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            ><path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2.5"
                                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                            ></path></svg
                        >
                        自分の支払いに
                    </button>
                    <button
                        onclick={addAmountToAll}
                        class="bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-bold py-3.5 rounded-2xl flex flex-col items-center justify-center gap-1.5 active:scale-95 transition-all text-sm shadow-sm group"
                    >
                        <svg
                            class="w-6 h-6 text-indigo-500 mb-0.5 group-active:-translate-y-1 transition-transform"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            ><path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2.5"
                                d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                            ></path></svg
                        >
                        全員で割る
                    </button>
                </div>

                <!-- Keys -->
                <div class="grid grid-cols-3 gap-2">
                    {#each ["7", "8", "9", "4", "5", "6", "1", "2", "3", "00", "0", "C"] as key}
                        <button
                            onclick={() => handleNumpad(key)}
                            class="{key === 'C'
                                ? 'bg-red-50 text-red-500 hover:bg-red-100 border-red-100'
                                : 'bg-white text-gray-800 hover:bg-gray-50 border-gray-100'} font-black text-2xl py-4 rounded-2xl shadow-sm border active:scale-95 transition-all"
                            >{key}</button
                        >
                    {/each}
                </div>
            </div>
        </div>
    </div>

    <!-- TAB 2: SETTLE -->
    <div
        class="{activeTab === 'settle'
            ? 'block'
            : 'hidden'} max-w-3xl mx-auto px-4 space-y-6 mt-4"
    >
        <!-- Members Settings (former Left Column) -->
        <div class="space-y-6">
            <div class="space-y-6">
                <section
                    class="bg-white rounded-3xl shadow-sm border border-gray-200 p-6 {isHost
                        ? ''
                        : 'opacity-80'}"
                >
                    <div
                        class="flex items-center justify-between mb-5 border-b border-gray-100 pb-3"
                    >
                        <h2
                            class="text-lg font-bold text-gray-800 flex items-center gap-2"
                        >
                            <svg
                                class="w-5 h-5 text-gray-400"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                                ><path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    stroke-width="2"
                                    d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                                ></path></svg
                            >
                            メンバー
                        </h2>
                        {#if isHost}
                            <button
                                onclick={addParticipant}
                                class="text-primary-600 hover:text-primary-700 bg-primary-50 p-1.5 rounded-lg transition-colors"
                                title="追加"
                            >
                                <svg
                                    class="w-5 h-5"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                    ><path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2"
                                        d="M12 4v16m8-8H4"
                                    ></path></svg
                                >
                            </button>
                        {/if}
                    </div>

                    <div class="space-y-4">
                        {#each participants as p (p.id)}
                            <div
                                class="bg-gray-50 border {p.id ===
                                myParticipantId
                                    ? 'border-indigo-300 shadow-sm bg-indigo-50/30'
                                    : 'border-gray-100'} rounded-2xl p-4 relative group"
                            >
                                {#if isHost}
                                    <button
                                        aria-label="削除"
                                        onclick={() => removeParticipant(p.id)}
                                        class="absolute -top-2 -right-2 bg-white border border-gray-200 text-gray-400 hover:text-red-500 rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                                    >
                                        <svg
                                            class="w-4 h-4"
                                            fill="none"
                                            stroke="currentColor"
                                            viewBox="0 0 24 24"
                                            ><path
                                                stroke-linecap="round"
                                                stroke-linejoin="round"
                                                stroke-width="2"
                                                d="M6 18L18 6M6 6l12 12"
                                            ></path></svg
                                        >
                                    </button>
                                {/if}
                                <div class="space-y-3">
                                    <div class="flex items-center gap-2">
                                        <input
                                            type="text"
                                            bind:value={p.name}
                                            oninput={saveAndRecalculate}
                                            disabled={!isHost &&
                                                p.id !== myParticipantId}
                                            class="w-full px-3 py-2 border-transparent bg-white shadow-sm rounded-xl focus:ring-2 focus:ring-primary-500 text-sm font-bold text-gray-800 transition-colors disabled:bg-gray-100 disabled:text-gray-500"
                                            placeholder="名前"
                                        />
                                        {#if isHost && p.id !== myParticipantId}
                                            <button
                                                onclick={() =>
                                                    transferHost(p.id)}
                                                class="text-[10px] text-indigo-600 hover:text-white hover:bg-indigo-500 bg-indigo-50 px-2 py-1.5 rounded-lg transition-colors font-bold whitespace-nowrap shadow-sm flex items-center gap-1 border border-indigo-100"
                                                title="この人に幹事を渡す"
                                            >
                                                <svg
                                                    class="w-3.5 h-3.5"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    viewBox="0 0 24 24"
                                                    ><path
                                                        stroke-linecap="round"
                                                        stroke-linejoin="round"
                                                        stroke-width="2.5"
                                                        d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                                                    ></path></svg
                                                >
                                                幹事に任命
                                            </button>
                                        {/if}
                                    </div>

                                    <div
                                        class="flex items-center rounded-xl bg-gray-200 p-1 select-none {!isHost &&
                                        p.id !== myParticipantId
                                            ? 'opacity-50 pointer-events-none'
                                            : ''}"
                                    >
                                        <button
                                            onclick={() => {
                                                p.paymentMethod = "PayPay";
                                                saveAndRecalculate();
                                            }}
                                            class="flex-1 py-1.5 text-xs font-bold rounded-lg transition-all {p.paymentMethod ===
                                            'PayPay'
                                                ? 'bg-white text-[#FF0033] shadow-sm'
                                                : 'text-gray-500 hover:text-gray-700'}"
                                            >PayPay</button
                                        >
                                        <button
                                            onclick={() => {
                                                p.paymentMethod = "Cash";
                                                saveAndRecalculate();
                                            }}
                                            class="flex-1 py-1.5 text-xs font-bold rounded-lg transition-all {p.paymentMethod ===
                                            'Cash'
                                                ? 'bg-white text-green-600 shadow-sm'
                                                : 'text-gray-500 hover:text-gray-700'}"
                                            >現金</button
                                        >
                                    </div>

                                    {#if p.paymentMethod === "PayPay"}
                                        <div
                                            id="tutorial-paypay-input"
                                            class="space-y-2"
                                        >
                                            <input
                                                type="text"
                                                bind:value={p.paypayId}
                                                oninput={saveAndRecalculate}
                                                disabled={!isHost &&
                                                    p.id !== myParticipantId}
                                                class="w-full px-3 py-2 border border-gray-200 bg-white rounded-xl focus:ring-2 focus:ring-primary-500 text-xs transition-colors disabled:bg-gray-100 placeholder-gray-400"
                                                placeholder="PayPay受取リンク または ID"
                                                title="PayPayアプリの「受け取る」からリンクをコピーして貼り付けてください"
                                            />
                                            {#if isHost || p.id === myParticipantId}
                                                <div
                                                    class="bg-gray-50 rounded-xl p-3 border border-gray-100 flex flex-col gap-2"
                                                >
                                                    <div
                                                        class="text-xs text-gray-500 font-medium space-y-1"
                                                    >
                                                        <p
                                                            class="font-bold text-gray-600 mb-1.5 flex items-center gap-1"
                                                        >
                                                            <svg
                                                                class="w-3.5 h-3.5"
                                                                fill="none"
                                                                stroke="currentColor"
                                                                viewBox="0 0 24 24"
                                                                ><path
                                                                    stroke-linecap="round"
                                                                    stroke-linejoin="round"
                                                                    stroke-width="2.5"
                                                                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                                                ></path></svg
                                                            >
                                                            リンクの取得方法
                                                        </p>
                                                        <ul
                                                            class="space-y-0.5 ml-1"
                                                        >
                                                            <li>
                                                                1.
                                                                PayPay右下の「アカウント」
                                                            </li>
                                                            <li>
                                                                2.
                                                                「マイコード」をタップ
                                                            </li>
                                                            <li>
                                                                3.
                                                                「このページのURLをコピー」
                                                            </li>
                                                        </ul>
                                                    </div>
                                                    <button
                                                        onclick={() =>
                                                            window.open(
                                                                "paypay://",
                                                                "_blank",
                                                            )}
                                                        class="self-start mt-0.5 flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:text-gray-800 rounded-lg text-xs font-bold transition-all shadow-sm active:scale-95"
                                                    >
                                                        <svg
                                                            class="w-3.5 h-3.5"
                                                            fill="none"
                                                            stroke="currentColor"
                                                            viewBox="0 0 24 24"
                                                            ><path
                                                                stroke-linecap="round"
                                                                stroke-linejoin="round"
                                                                stroke-width="2"
                                                                d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                                                            ></path></svg
                                                        >
                                                        PayPayアプリを開く
                                                    </button>
                                                </div>
                                            {/if}
                                        </div>
                                    {/if}
                                </div>
                            </div>
                        {/each}
                    </div>

                    <div class="mt-8 border-t border-gray-100 pt-5">
                        <label
                            class="block text-sm font-bold text-gray-700 mb-2"
                            for="roundMode">現金派の丸め方</label
                        >
                        <select
                            id="roundMode"
                            bind:value={roundMode}
                            onchange={saveAndRecalculate}
                            disabled={!isHost}
                            class="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-500 text-sm font-medium text-gray-700 disabled:opacity-50"
                        >
                            <option value="none">丸めない（1円単位）</option>
                            <option value="nearest">普通に四捨五入</option>
                            <option value="down">払い・受取りを少なく</option>
                            <option value="up">払い・受取りを多く</option>
                        </select>
                    </div>
                </section>
            </div>

            <!-- Results & Settlements (Moved directly under members) -->
            <div class="space-y-6 pt-6">
                <!-- Receipt removal notice -->
                <div
                    class="bg-gray-50/80 rounded-2xl p-4 text-gray-500 text-xs text-center border border-gray-100 flex items-center justify-center gap-2 shadow-sm"
                >
                    <svg
                        class="w-4 h-4 text-gray-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        ><path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                        ></path></svg
                    >
                    タブ1「注文メモ」の計算結果がここに自動反映されます
                </div>

                <div
                    class="bg-white rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.04)] overflow-hidden border border-gray-100/80"
                >
                    <div class="p-6 md:p-8">
                        <h2
                            class="text-xl font-bold mb-6 flex items-center gap-3 text-gray-800"
                        >
                            <div
                                class="w-10 h-10 rounded-2xl bg-indigo-50 flex items-center justify-center text-indigo-600 shadow-sm border border-indigo-100/50"
                            >
                                <svg
                                    class="w-5 h-5"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                    ><path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2.5"
                                        d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"
                                    ></path></svg
                                >
                            </div>
                            最終精算
                        </h2>

                        {#if unpaidCount > 0}
                            <div
                                class="bg-red-50 border border-red-100 rounded-2xl p-4 flex items-center gap-4 shadow-sm mb-2"
                            >
                                <div
                                    class="bg-red-100 p-2.5 rounded-xl text-red-600 shadow-sm shrink-0"
                                >
                                    <svg
                                        class="w-5 h-5"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                        ><path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            stroke-width="2.5"
                                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                                        ></path></svg
                                    >
                                </div>
                                <div class="flex flex-col">
                                    <span
                                        class="text-[#FF0033] font-black text-sm tracking-wide"
                                        >未払い：残り{unpaidCount}名</span
                                    >
                                    <span
                                        class="text-[#FF0033]/80 text-xs font-bold mt-0.5"
                                        >送金後に「未完了」ボタンをタップして消し込めます</span
                                    >
                                </div>
                            </div>
                        {/if}

                        <div class="space-y-6">
                            <div>
                                <h3
                                    class="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider"
                                >
                                    誰が誰に払うか
                                </h3>
                                <div class="space-y-3">
                                    {#if transactions.length === 0}
                                        <div
                                            class="bg-gray-50/50 rounded-2xl p-6 text-center text-gray-400 text-sm border border-gray-100"
                                        >
                                            精算が必要なトランザクションはありません。<br
                                            />（みんなぴったりです！）
                                        </div>
                                    {:else}
                                        {#each transactions as t}
                                            <div
                                                class="bg-white rounded-2xl p-5 shadow-[0_2px_10px_rgba(0,0,0,0.03)] border border-gray-100/80 transform transition hover:-translate-y-1"
                                            >
                                                <div
                                                    class="flex items-center justify-between mb-4"
                                                >
                                                    <div
                                                        class="flex items-center gap-3 flex-1 overflow-hidden"
                                                    >
                                                        <div
                                                            class="font-black text-gray-800 truncate text-base"
                                                        >
                                                            {t.fromName}
                                                        </div>
                                                        <div
                                                            class="text-gray-300 flex-shrink-0"
                                                        >
                                                            <svg
                                                                class="w-4 h-4"
                                                                fill="none"
                                                                stroke="currentColor"
                                                                viewBox="0 0 24 24"
                                                                ><path
                                                                    stroke-linecap="round"
                                                                    stroke-linejoin="round"
                                                                    stroke-width="2"
                                                                    d="M14 5l7 7m0 0l-7 7m7-7H3"
                                                                ></path></svg
                                                            >
                                                        </div>
                                                        <div
                                                            class="font-bold text-gray-600 truncate text-base"
                                                        >
                                                            {t.toName}
                                                        </div>
                                                    </div>
                                                </div>
                                                <div
                                                    class="flex items-end justify-between border-b border-gray-100 pb-4 mb-4"
                                                >
                                                    <span
                                                        class="text-[10px] font-black px-2.5 py-1 rounded-lg uppercase tracking-wider {t.method ===
                                                        'PayPay'
                                                            ? 'bg-[#FF0033]/10 text-[#FF0033]'
                                                            : 'bg-emerald-100 text-emerald-700'}"
                                                    >
                                                        {t.method}
                                                    </span>
                                                    <span
                                                        class="text-4xl md:text-5xl font-black text-gray-800 tracking-tighter"
                                                        >¥{t.amount.toLocaleString()}</span
                                                    >
                                                </div>

                                                {#if t.method === "PayPay" && t.toPaypayId}
                                                    {@const paypayLink =
                                                        t.toPaypayId.startsWith(
                                                            "http",
                                                        ) ||
                                                        t.toPaypayId.startsWith(
                                                            "paypay://",
                                                        )
                                                            ? t.toPaypayId
                                                            : `paypay://send?userNum=${t.toPaypayId}&amount=${t.amount}`}
                                                    <div class="mt-2">
                                                        <button
                                                            onclick={() =>
                                                                handlePayPayClick(
                                                                    t.fromId,
                                                                    t.amount,
                                                                    paypayLink,
                                                                )}
                                                            class="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[#FF0033] text-white text-sm font-bold rounded-xl hover:bg-[#E6002E] transition-all shadow-md shadow-[#FF0033]/30 active:scale-95"
                                                        >
                                                            <svg
                                                                class="w-5 h-5"
                                                                fill="none"
                                                                stroke="currentColor"
                                                                viewBox="0 0 24 24"
                                                                ><path
                                                                    stroke-linecap="round"
                                                                    stroke-linejoin="round"
                                                                    stroke-width="2"
                                                                    d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                                                                ></path></svg
                                                            >
                                                            PayPayで送金する
                                                        </button>
                                                    </div>
                                                {/if}
                                            </div>
                                        {/each}
                                    {/if}

                                    {#if hostAbsorbedAmount > 0 && roundMode !== "none"}
                                        {@const host = participants.find(
                                            (p) => p.id === currentHostId,
                                        )}
                                        {#if host}
                                            <div
                                                class="mt-4 p-4 bg-indigo-50/50 rounded-2xl border border-indigo-100/50 flex items-center justify-center gap-3 shadow-sm"
                                            >
                                                <div class="text-indigo-400">
                                                    <svg
                                                        class="w-5 h-5"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        viewBox="0 0 24 24"
                                                        ><path
                                                            stroke-linecap="round"
                                                            stroke-linejoin="round"
                                                            stroke-width="2"
                                                            d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
                                                        ></path></svg
                                                    >
                                                </div>
                                                <div
                                                    class="text-xs font-bold text-indigo-700 leading-relaxed text-center"
                                                >
                                                    幹事（{host.name}）が計
                                                    <span
                                                        class="text-indigo-900 text-sm mx-0.5"
                                                        >¥{Math.round(
                                                            hostAbsorbedAmount,
                                                        ).toLocaleString()}</span
                                                    > の端数を被ってくれています
                                                </div>
                                            </div>
                                        {/if}
                                    {/if}
                                </div>
                            </div>

                            <div class="pt-8 border-t border-gray-100">
                                <h3
                                    class="text-xs font-bold text-gray-400 mb-4 uppercase tracking-wider"
                                >
                                    個人のトータル収支
                                </h3>
                                <div
                                    class="grid grid-cols-2 sm:grid-cols-3 gap-3"
                                >
                                    {#each balances as r}
                                        <div
                                            class="bg-gray-50/80 p-4 rounded-2xl flex flex-col items-center text-center relative border transition-all {r.participantId ===
                                            myParticipantId
                                                ? 'border-indigo-200 shadow-sm shadow-indigo-100/50 bg-indigo-50/30'
                                                : 'border-transparent'}"
                                        >
                                            {#if r.participantId === myParticipantId}
                                                <span
                                                    class="absolute -top-2.5 bg-indigo-500 text-white text-[9px] font-black px-2.5 py-0.5 rounded-full z-10 shadow-sm"
                                                    >YOU</span
                                                >
                                            {/if}
                                            <span
                                                class="text-xs font-bold text-gray-500 mb-1.5 w-full truncate"
                                                >{r.name}</span
                                            >
                                            <span
                                                class="text-xl font-black tracking-tight {r.roundedBalance >
                                                0
                                                    ? 'text-emerald-500'
                                                    : r.roundedBalance < 0
                                                      ? 'text-gray-800'
                                                      : 'text-gray-400'}"
                                            >
                                                {r.roundedBalance > 0
                                                    ? "+"
                                                    : ""}{r.roundedBalance.toLocaleString()}
                                            </span>
                                            <span
                                                class="text-[10px] mt-1 font-bold text-gray-400"
                                                >{r.paymentMethod}</span
                                            >

                                            <!-- Sync settlement button -->
                                            <button
                                                onclick={() =>
                                                    toggleSettlement(
                                                        r.participantId,
                                                    )}
                                                disabled={r.participantId !==
                                                    myParticipantId && !isHost}
                                                class="mt-4 w-full py-2.5 text-xs font-black rounded-xl transition-all flex items-center justify-center gap-1.5 {settlements[
                                                    r.participantId
                                                ]
                                                    ? 'bg-emerald-500 text-white shadow-sm hover:bg-emerald-600'
                                                    : 'bg-white text-gray-400 border border-gray-200 shadow-sm hover:bg-gray-50 hover:text-gray-600 disabled:opacity-50 disabled:hover:bg-white disabled:shadow-none'}"
                                            >
                                                {#if settlements[r.participantId]}
                                                    <svg
                                                        class="w-3.5 h-3.5"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        viewBox="0 0 24 24"
                                                        ><path
                                                            stroke-linecap="round"
                                                            stroke-linejoin="round"
                                                            stroke-width="3"
                                                            d="M5 13l4 4L19 7"
                                                        ></path></svg
                                                    >
                                                    支払済
                                                {:else}
                                                    <svg
                                                        class="w-3.5 h-3.5 opacity-70"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        viewBox="0 0 24 24"
                                                        ><path
                                                            stroke-linecap="round"
                                                            stroke-linejoin="round"
                                                            stroke-width="2"
                                                            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                                        ></path></svg
                                                    >
                                                    未完了
                                                {/if}
                                            </button>
                                        </div>
                                    {/each}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {#if isHost}
                <div class="pt-8 mb-8">
                    <button
                        onclick={deleteRoom}
                        class="w-full py-4 bg-red-50 hover:bg-red-100 text-red-600 text-sm font-bold rounded-2xl transition-colors border border-red-100 shadow-sm flex items-center justify-center gap-2"
                    >
                        <svg
                            class="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            ><path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            ></path></svg
                        >
                        精算を完全に終了する（ルーム削除）
                    </button>
                </div>
            {/if}
        </div>
    </div>
</main>
