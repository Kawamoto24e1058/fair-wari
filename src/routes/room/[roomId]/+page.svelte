<script lang="ts">
    import { goto } from "$app/navigation";
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
    let newParticipantPaypayLink = $state("");

    let showQrModal = $state(false);
    let qrDataUrl = $state("");

    let toastMessage = $state("");
    let showToast = $state(false);

    let unsubscribe: (() => void) | undefined;

    // Will be defined at the bottom
    let startTutorial = $state(() => {});

    // Lock background scroll when modal is open
    $effect(() => {
        if (showIdentityModal || showQrModal) {
            document.body.style.overflow = "hidden";
        } else {
            document.body.style.overflow = "";
        }
    });

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

        // Initialize driver.js tutorial if not seen and already joined
        setTimeout(() => {
            if (myParticipantId && !localStorage.getItem("hasSeenTutorial")) {
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

        // Calculate expiration: Now + 1 hour
        const expirationDate = new Date();
        expirationDate.setHours(expirationDate.getHours() + 1);

        await updateDoc(roomRef, {
            state: { participants, events, roundMode },
            settlements,
            expiresAt: expirationDate, // Rolling TTL update
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
        // Trigger save (and TTL extension) for any user activity
        saveStateToFirebase();
    }

    function joinAsNewParticipant() {
        if (!newParticipantName.trim()) return alert("名前を入力してください");

        const id = Date.now().toString();
        const newP: Participant = {
            id,
            name: newParticipantName,
            paymentMethod: newParticipantMethod,
            paypayId: "",
            paypayLink: newParticipantPaypayLink,
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

        // Start tutorial if joining for the first time
        setTimeout(() => {
            if (!localStorage.getItem("hasSeenTutorial")) {
                startTutorial();
            }
        }, 500);

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

        // Start tutorial if joining as existing for the first time
        setTimeout(() => {
            if (!localStorage.getItem("hasSeenTutorial")) {
                startTutorial();
            }
        }, 500);
    }

    function toggleSettlement(pid: string) {
        if (!isHost) return;
        settlements[pid] = !settlements[pid];
        saveStateToFirebase();
    }

    function updateMyPaymentMethod(method: "PayPay" | "Cash") {
        if (!myParticipantId) return;
        const p = participants.find((p) => p.id === myParticipantId);
        if (p) {
            p.paymentMethod = method;
            saveAndRecalculate();
        }
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

    async function leaveRoom() {
        if (!confirm("ルームから退出しますか？")) return;

        // セッション情報をクリア
        localStorage.removeItem(`room_${roomId}_identity`);
        myParticipantId = null;
        isHost = false;

        // トップページへ
        await goto("/");
    }

    function showToastNotification(message: string) {
        toastMessage = message;
        showToast = true;
        setTimeout(() => {
            showToast = false;
        }, 3000);
    }

    async function handlePayPayClick(fromId: string, amount: number) {
        // 幹事の特定
        const host = participants.find((p) => p.id === currentHostId);
        const paypayUrl = host?.paypayLink;

        if (!paypayUrl) {
            return alert(
                "幹事のPayPay受取リンクが設定されていません。幹事に設定を依頼してください。",
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
        const remainder = amount % participants.length;

        participants.forEach((p) => {
            p.amount = (p.amount || 0) + perPerson;
            // The person performing the operation absorbs the remainder
            if (p.id === myParticipantId) {
                p.amount += remainder;
            }
        });

        currentAmount = "";
        saveAndRecalculate();
        showToastNotification(
            `各員に ¥${perPerson.toLocaleString()} ずつ追加しました${remainder > 0 ? `（端数 ${remainder}円はあなたに加算）` : ""}`,
        );
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
        if (!(window as any).driver) {
            console.warn("Driver.js not loaded yet, retrying in 500ms...");
            setTimeout(startTutorial, 500);
            return;
        }

        const driverObj = (window as any).driver.js.driver({
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
                        title: "FairPayへようこそ",
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
    <title>FairPay - ルーム</title>
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

        /* Utility: Hide scrollbar */
        .scrollbar-none::-webkit-scrollbar {
            display: none;
        }
        .scrollbar-none {
            -ms-overflow-style: none;
            scrollbar-width: none;
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
        <div
            class="bg-white rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl max-h-[90vh] overflow-y-auto"
        >
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

                <div class="flex items-center rounded-xl bg-gray-200 p-1 mb-4">
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

                {#if newParticipantMethod === "PayPay"}
                    <div class="mb-6 animate-fade-in">
                        <label
                            class="block text-xs font-bold text-gray-400 mb-1.5 uppercase tracking-wider"
                            for="modal-paypay-link"
                            >PayPayマイコードURL {#if isHost}(幹事の場合は必須){/if}</label
                        >
                        <input
                            id="modal-paypay-link"
                            type="text"
                            bind:value={newParticipantPaypayLink}
                            placeholder="https://paypay.me/..."
                            class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-500 text-sm font-bold mb-3 shadow-sm transition-all"
                        />

                        <div
                            class="bg-gray-50 rounded-2xl p-4 border border-gray-100"
                        >
                            <p
                                class="font-extrabold text-gray-800 mb-4 flex items-center gap-2 text-sm"
                            >
                                <svg
                                    class="w-5 h-5 text-[#FF0033]"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2.5"
                                        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                    />
                                </svg>
                                URLの取得方法（3ステップ）
                            </p>

                            <div
                                class="flex gap-4 overflow-x-auto pb-6 -mx-2 px-2 scrollbar-none snap-x"
                            >
                                <!-- Step 1 -->
                                <div class="flex-shrink-0 w-48 snap-start">
                                    <div
                                        class="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden mb-2 aspect-[4/5] relative group"
                                    >
                                        <img
                                            src="/step1.png"
                                            alt="Step 1"
                                            class="w-full h-full object-cover object-bottom transition-transform group-hover:scale-110"
                                        />
                                        <div
                                            class="absolute top-2 left-2 w-6 h-6 bg-gray-900/80 backdrop-blur text-white text-[10px] font-black rounded-full flex items-center justify-center border border-white/20"
                                        >
                                            1
                                        </div>
                                    </div>
                                    <p
                                        class="text-[10px] font-bold text-gray-500 leading-snug"
                                    >
                                        右下の<span class="text-gray-900"
                                            >「アカウント」</span
                                        >をタップ
                                    </p>
                                </div>

                                <!-- Step 2 -->
                                <div class="flex-shrink-0 w-48 snap-start">
                                    <div
                                        class="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden mb-2 aspect-[4/5] relative group"
                                    >
                                        <img
                                            src="/step2.png"
                                            alt="Step 2"
                                            class="w-full h-full object-cover transition-transform group-hover:scale-110"
                                        />
                                        <div
                                            class="absolute top-2 left-2 w-6 h-6 bg-gray-900/80 backdrop-blur text-white text-[10px] font-black rounded-full flex items-center justify-center border border-white/20"
                                        >
                                            2
                                        </div>
                                    </div>
                                    <p
                                        class="text-[10px] font-bold text-gray-500 leading-snug"
                                    >
                                        中央の<span class="text-gray-900"
                                            >「マイコード」</span
                                        >を選択
                                    </p>
                                </div>

                                <!-- Step 3 -->
                                <div class="flex-shrink-0 w-48 snap-start">
                                    <div
                                        class="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden mb-2 aspect-[4/5] relative group"
                                    >
                                        <img
                                            src="/step3.png"
                                            alt="Step 3"
                                            class="w-full h-full object-cover transition-transform group-hover:scale-110"
                                        />
                                        <div
                                            class="absolute top-2 left-2 w-6 h-6 bg-gray-900/80 backdrop-blur text-white text-[10px] font-black rounded-full flex items-center justify-center border border-white/20"
                                        >
                                            3
                                        </div>
                                    </div>
                                    <p
                                        class="text-[10px] font-bold text-gray-500 leading-snug"
                                    >
                                        下部の<span class="text-gray-900"
                                            >「リンクをコピー」</span
                                        >をタップ
                                    </p>
                                </div>
                            </div>

                            <button
                                onclick={() =>
                                    window.open(
                                        "paypay://",
                                        "_blank",
                                        "noopener,noreferrer",
                                    )}
                                class="w-full flex items-center justify-center gap-2 py-3 bg-[#FF0033]/5 text-[#FF0033] hover:bg-[#FF0033]/10 rounded-2xl text-xs font-black transition-all shadow-sm active:scale-95 border border-[#FF0033]/10"
                            >
                                <svg
                                    class="w-4 h-4"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2.5"
                                        d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                                    />
                                </svg>
                                PayPayアプリを開く
                            </button>
                        </div>
                    </div>
                {/if}

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
                    FairPay
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
                    onclick={leaveRoom}
                    class="p-2 text-gray-400 hover:text-red-500 transition-colors flex items-center gap-1 group"
                    title="ルームを退出"
                >
                    <svg
                        class="w-5 h-5 group-hover:-translate-x-1 transition-transform"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                        />
                    </svg>
                    <span class="text-xs font-bold hidden sm:inline">退出</span>
                </button>
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
            : 'hidden'} max-w-7xl mx-auto px-4 relative"
    >
        <div
            class="grid grid-cols-1 md:grid-cols-2 gap-8 items-start pt-4 mb-20 md:mb-10"
        >
            <!-- Right Column: Burden List (Order 1 on mobile) -->
            <div class="order-1 md:order-2 space-y-6">
                <section
                    class="bg-white rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.04)] border border-gray-100 p-6 md:p-8"
                >
                    <div class="flex items-center justify-between mb-6">
                        <h2
                            class="text-xl font-bold text-gray-800 flex items-center gap-3"
                        >
                            <div
                                class="w-10 h-10 rounded-2xl bg-indigo-50 flex items-center justify-center text-indigo-600 shadow-sm border border-indigo-100/50"
                            >
                                <svg
                                    class="w-5 h-5"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2.5"
                                        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                                    />
                                </svg>
                            </div>
                            現在の負担額
                        </h2>
                        <div class="text-right">
                            <span
                                class="text-[10px] text-gray-400 font-bold uppercase tracking-wider block mb-0.5"
                                >テーブル合計</span
                            >
                            <span
                                class="text-2xl font-black text-indigo-600 tracking-tighter"
                            >
                                ¥{balances
                                    .reduce(
                                        (acc, b) =>
                                            acc + Math.abs(b.roundedBalance),
                                        0,
                                    )
                                    .toLocaleString()}
                            </span>
                        </div>
                    </div>

                    <div class="space-y-3">
                        {#each balances as r}
                            <div
                                class="bg-white border border-gray-100 rounded-2xl p-4 flex justify-between items-center relative shadow-sm hover:shadow-md transition-shadow group"
                            >
                                {#if r.participantId === myParticipantId}
                                    <div
                                        class="absolute -top-2 left-4 bg-indigo-500 text-white text-[9px] font-black px-2 py-0.5 rounded-full shadow-sm z-10"
                                    >
                                        YOU
                                    </div>
                                {/if}
                                <div class="flex items-center gap-3">
                                    <div
                                        class="w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center font-bold text-gray-400 border border-gray-100 text-xs transition-colors group-hover:bg-indigo-50 group-hover:text-indigo-400 group-hover:border-indigo-100"
                                    >
                                        {r.name.substring(0, 2)}
                                    </div>
                                    <div
                                        class="font-bold text-gray-700 text-base"
                                    >
                                        {r.name}
                                    </div>
                                </div>
                                <div class="text-right flex-shrink-0">
                                    <div
                                        class="text-xl font-black text-gray-800 tracking-tight"
                                    >
                                        ¥{Math.abs(
                                            r.roundedBalance,
                                        ).toLocaleString()}
                                    </div>
                                </div>
                            </div>
                        {/each}
                        {#if balances.length === 0}
                            <div
                                class="text-center py-12 bg-gray-50/50 rounded-2xl border border-dashed border-gray-200"
                            >
                                <p class="text-sm text-gray-400 font-medium">
                                    まだメンバーがいません
                                </p>
                            </div>
                        {/if}
                    </div>
                </section>
            </div>

            <!-- Left Column: Numpad (Order 2 on mobile) -->
            <div class="order-2 md:order-1">
                <div class="md:sticky md:top-24 max-w-md mx-auto w-full">
                    <div
                        class="bg-white rounded-[2.5rem] shadow-[0_20px_50px_rgba(0,0,0,0.06)] border border-gray-100 p-6 md:p-8"
                    >
                        <!-- Display -->
                        <div
                            class="bg-gray-50 rounded-3xl p-5 mb-6 text-right overflow-hidden border border-gray-100 shadow-inner flex flex-col justify-center gap-1 min-h-[100px]"
                        >
                            <span
                                class="text-gray-400 font-bold text-xs uppercase tracking-widest"
                                >入力金額</span
                            >
                            <span
                                class="text-5xl font-black text-gray-800 tracking-tighter truncate leading-none"
                                >¥{currentAmount
                                    ? parseInt(
                                          currentAmount,
                                          10,
                                      ).toLocaleString()
                                    : "0"}</span
                            >
                        </div>

                        <!-- Action Buttons -->
                        <div class="grid grid-cols-2 gap-4 mb-6">
                            <button
                                onclick={addAmountToMyself}
                                class="bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-bold py-4 rounded-3xl flex flex-col items-center justify-center gap-2 active:scale-95 transition-all text-xs shadow-sm group border border-emerald-100/50"
                            >
                                <div
                                    class="w-10 h-10 rounded-2xl bg-white flex items-center justify-center text-emerald-500 shadow-sm border border-emerald-100 group-hover:scale-110 transition-transform"
                                >
                                    <svg
                                        class="w-6 h-6"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                    >
                                        <path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            stroke-width="2.5"
                                            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                                        />
                                    </svg>
                                </div>
                                自分の支払いに
                            </button>
                            <button
                                onclick={addAmountToAll}
                                class="bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-bold py-4 rounded-3xl flex flex-col items-center justify-center gap-2 active:scale-95 transition-all text-xs shadow-sm group border border-indigo-100/50"
                            >
                                <div
                                    class="w-10 h-10 rounded-2xl bg-white flex items-center justify-center text-indigo-500 shadow-sm border border-indigo-100 group-hover:scale-110 transition-transform"
                                >
                                    <svg
                                        class="w-6 h-6"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                    >
                                        <path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            stroke-width="2.5"
                                            d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                                        />
                                    </svg>
                                </div>
                                全員で割る
                            </button>
                        </div>

                        <!-- Keys -->
                        <div class="grid grid-cols-3 gap-3">
                            {#each ["7", "8", "9", "4", "5", "6", "1", "2", "3", "00", "0", "C"] as key}
                                <button
                                    onclick={() => handleNumpad(key)}
                                    class="{key === 'C'
                                        ? 'bg-red-50 text-red-500 hover:bg-red-100 border-red-100'
                                        : 'bg-white text-gray-800 hover:bg-gray-50 border-gray-100'} font-black text-2xl py-5 rounded-3xl shadow-sm border active:scale-95 transition-all"
                                    >{key}</button
                                >
                            {/each}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- TAB 2: SETTLE -->
    <div
        class="{activeTab === 'settle'
            ? 'block'
            : 'hidden'} max-w-3xl mx-auto px-4 space-y-8 mt-6 pb-20"
    >
        {#if isHost}
            {@const totalExpected = transactions.reduce(
                (acc, t) => acc + t.amount,
                0,
            )}
            {@const currentCollected = transactions
                .filter((t) => settlements[t.fromId])
                .reduce((acc, t) => acc + t.amount, 0)}
            {@const totalGuests = transactions.length}
            {@const paidGuests = totalGuests - unpaidCount}
            {@const progressPercent =
                totalExpected > 0
                    ? (currentCollected / totalExpected) * 100
                    : 0}
            {@const isComplete = totalGuests > 0 && unpaidCount === 0}

            <!-- HOST VIEW: Collection Dashboard -->
            <section class="space-y-6 animate-fade-in">
                <!-- Dashboard Summary Card (Enhanced Progress) -->

                <div
                    class="bg-white rounded-[2.5rem] shadow-[0_20px_60px_rgba(0,0,0,0.05)] border border-gray-100 p-8 space-y-8"
                >
                    <div
                        class="flex flex-col md:flex-row md:items-end justify-between gap-6"
                    >
                        <div class="space-y-1">
                            <h2
                                class="text-gray-400 text-xs font-black uppercase tracking-[0.2em]"
                            >
                                集金状況
                            </h2>
                            <div class="flex items-baseline gap-2">
                                <span
                                    class="text-5xl font-black text-gray-900 tracking-tighter"
                                    >¥{currentCollected.toLocaleString()}</span
                                >
                                <span class="text-xl font-bold text-gray-300"
                                    >/ ¥{totalExpected.toLocaleString()}</span
                                >
                            </div>
                        </div>
                        <div class="text-right">
                            <div class="text-sm font-black text-gray-500 mb-1">
                                集金済み <span class="text-indigo-600 text-lg"
                                    >{paidGuests}</span
                                >
                                / {totalGuests} 人
                            </div>
                            {#if isComplete}
                                <div
                                    class="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-50 text-emerald-600 rounded-lg text-xs font-black border border-emerald-100"
                                >
                                    <svg
                                        class="w-3.5 h-3.5"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                    >
                                        <path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            stroke-width="3"
                                            d="M5 13l4 4L19 7"
                                        />
                                    </svg>
                                    集金完了！
                                </div>
                            {:else}
                                <div
                                    class="inline-flex items-center gap-1.5 px-3 py-1 bg-indigo-50 text-indigo-600 rounded-lg text-xs font-black border border-indigo-100"
                                >
                                    残り {unpaidCount} 人
                                </div>
                            {/if}
                        </div>
                    </div>

                    <div class="space-y-3">
                        <div
                            class="relative w-full h-4 bg-gray-100 rounded-full overflow-hidden shadow-inner"
                        >
                            <div
                                class="absolute top-0 left-0 h-full transition-all duration-700 ease-out {isComplete
                                    ? 'bg-emerald-500'
                                    : 'bg-indigo-600'}"
                                style="width: {progressPercent}%"
                            >
                                {#if progressPercent > 10}
                                    <div
                                        class="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-[shimmer_2s_infinite]"
                                    ></div>
                                {/if}
                            </div>
                        </div>
                        <div
                            class="flex justify-between text-[10px] font-black text-gray-400 uppercase tracking-widest px-1"
                        >
                            <span>START</span>
                            <span>{Math.round(progressPercent)}%</span>
                            <span>GOAL</span>
                        </div>
                    </div>
                </div>

                <!-- Guest List (Settlement Tracking) -->
                <div class="space-y-4">
                    <div class="flex items-center justify-between pl-4 pr-2">
                        <h3
                            class="text-sm font-black text-gray-400 uppercase tracking-widest"
                        >
                            ゲスト別ステータス
                        </h3>
                        <div
                            class="text-[10px] font-bold text-gray-300 uppercase"
                        >
                            タップして変更
                        </div>
                    </div>

                    <div class="grid gap-3">
                        {#each transactions as t}
                            {@const isPaid = settlements[t.fromId]}
                            <div
                                class="bg-white rounded-3xl p-5 border border-gray-100 shadow-sm flex items-center justify-between transition-all duration-300 {isPaid
                                    ? 'opacity-40 grayscale-[30%]'
                                    : 'hover:shadow-md hover:border-indigo-100 group'}"
                            >
                                <div class="flex items-center gap-4">
                                    <div
                                        class="w-12 h-12 rounded-2xl flex items-center justify-center font-bold border transition-colors {isPaid
                                            ? 'bg-gray-100 text-gray-400 border-gray-200'
                                            : 'bg-indigo-50 text-indigo-600 border-indigo-100 group-hover:bg-indigo-600 group-hover:text-white'}"
                                    >
                                        {t.fromName.substring(0, 1)}
                                    </div>
                                    <div>
                                        <div
                                            class="font-black text-gray-800 text-lg leading-tight transition-colors {isPaid
                                                ? 'text-gray-400'
                                                : 'text-gray-900'}"
                                        >
                                            {t.fromName}
                                        </div>
                                        <div
                                            class="text-2xl font-black transition-colors {isPaid
                                                ? 'text-gray-400'
                                                : 'text-indigo-600'}"
                                        >
                                            ¥{t.amount.toLocaleString()}
                                        </div>
                                    </div>
                                </div>

                                <button
                                    onclick={() => toggleSettlement(t.fromId)}
                                    class="flex items-center gap-2 px-5 py-3 rounded-2xl font-black text-sm transition-all shadow-sm active:scale-95 {isPaid
                                        ? 'bg-emerald-500 text-white border border-emerald-500 shadow-emerald-100'
                                        : 'bg-white text-indigo-600 border-2 border-indigo-50 hover:border-indigo-600 hover:bg-indigo-50'}"
                                >
                                    {#if isPaid}
                                        <svg
                                            class="w-4 h-4"
                                            fill="none"
                                            stroke="currentColor"
                                            viewBox="0 0 24 24"
                                        >
                                            <path
                                                stroke-linecap="round"
                                                stroke-linejoin="round"
                                                stroke-width="4"
                                                d="M5 13l4 4L19 7"
                                            />
                                        </svg>
                                        支払済
                                    {:else}
                                        未完了
                                    {/if}
                                </button>
                            </div>
                        {/each}
                        {#if transactions.length === 0}
                            <div
                                class="text-center py-16 bg-white rounded-[2.5rem] border-2 border-dashed border-gray-100"
                            >
                                <p class="text-gray-400 font-bold">
                                    精算が必要なゲストはいません
                                </p>
                            </div>
                        {/if}
                    </div>
                </div>

                <!-- Settings for Host (Participants & Round Mode) -->
                <div class="pt-10 border-t border-gray-100 space-y-8">
                    <div class="flex items-center justify-between px-2">
                        <h2
                            class="text-lg font-black text-gray-800 tracking-tight"
                        >
                            メンバー設定
                        </h2>
                        <button
                            onclick={addParticipant}
                            class="flex items-center gap-2 bg-gray-900 text-white px-4 py-2 rounded-xl text-xs font-black hover:bg-gray-800 transition-colors shadow-lg shadow-gray-200"
                        >
                            <svg
                                class="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    stroke-width="3"
                                    d="M12 4v16m8-8H4"
                                />
                            </svg>
                            メンバー追加
                        </button>
                    </div>

                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {#each participants as p (p.id)}
                            <div
                                class="bg-white border border-gray-100 rounded-3xl p-5 shadow-sm relative group"
                            >
                                <button
                                    onclick={() => removeParticipant(p.id)}
                                    class="absolute -top-2 -right-2 bg-white border border-gray-200 text-gray-300 hover:text-red-500 rounded-full p-1.5 opacity-0 group-hover:opacity-100 transition-opacity shadow-md"
                                >
                                    <svg
                                        class="w-4 h-4"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                    >
                                        <path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            stroke-width="2.5"
                                            d="M6 18L18 6M6 6l12 12"
                                        />
                                    </svg>
                                </button>
                                <div class="space-y-4">
                                    <input
                                        type="text"
                                        bind:value={p.name}
                                        oninput={saveAndRecalculate}
                                        class="w-full px-4 py-2 bg-gray-50 border-transparent focus:bg-white focus:ring-2 focus:ring-indigo-500 rounded-xl text-sm font-black text-gray-800 transition-all"
                                        placeholder="名前"
                                    />

                                    <div
                                        class="flex items-center rounded-2xl bg-gray-100 p-1"
                                    >
                                        <button
                                            onclick={() => {
                                                p.paymentMethod = "PayPay";
                                                saveAndRecalculate();
                                            }}
                                            class="flex-1 py-2 text-[10px] font-black rounded-xl transition-all {p.paymentMethod ===
                                            'PayPay'
                                                ? 'bg-white text-[#FF0033] shadow-sm'
                                                : 'text-gray-400'}"
                                            >PayPay</button
                                        >
                                        <button
                                            onclick={() => {
                                                p.paymentMethod = "Cash";
                                                saveAndRecalculate();
                                            }}
                                            class="flex-1 py-2 text-[10px] font-black rounded-xl transition-all {p.paymentMethod ===
                                            'Cash'
                                                ? 'bg-white text-emerald-600 shadow-sm'
                                                : 'text-gray-400'}">現金</button
                                        >
                                    </div>

                                    {#if currentHostId === p.id && p.paymentMethod === "PayPay"}
                                        <input
                                            type="text"
                                            bind:value={p.paypayLink}
                                            oninput={saveAndRecalculate}
                                            class="w-full px-4 py-2 bg-red-50/50 border border-red-100 focus:bg-white focus:ring-2 focus:ring-[#FF0033] rounded-xl text-xs font-bold text-[#FF0033] transition-all"
                                            placeholder="PayPay受取リンク (https://paypay.me/...)"
                                        />
                                    {/if}

                                    {#if currentHostId !== p.id}
                                        <button
                                            onclick={() => transferHost(p.id)}
                                            class="w-full py-2 bg-indigo-50 text-indigo-600 rounded-xl text-[10px] font-black hover:bg-indigo-600 hover:text-white transition-all border border-indigo-100/50"
                                            >幹事を交代する</button
                                        >
                                    {:else}
                                        <div
                                            class="w-full py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black text-center shadow-md shadow-indigo-100"
                                        >
                                            あなたは幹事です
                                        </div>
                                    {/if}
                                </div>
                            </div>
                        {/each}
                    </div>

                    <div
                        class="bg-white rounded-3xl p-6 border border-gray-100 shadow-sm"
                    >
                        <label
                            class="block text-xs font-black text-gray-400 uppercase tracking-widest mb-3"
                            for="roundMode">現金派の丸め方</label
                        >
                        <div class="grid grid-cols-2 gap-2">
                            {#each [{ val: "none", label: "1円単位" }, { val: "nearest", label: "四捨五入" }, { val: "down", label: "切り捨て" }, { val: "up", label: "切り上げ" }] as opt}
                                <button
                                    onclick={() => {
                                        roundMode = opt.val as any;
                                        saveAndRecalculate();
                                    }}
                                    class="py-3 rounded-xl border font-bold text-xs transition-all {roundMode ===
                                    opt.val
                                        ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg shadow-indigo-100'
                                        : 'bg-white border-gray-100 text-gray-500 hover:border-indigo-200'}"
                                    >{opt.label}</button
                                >
                            {/each}
                        </div>
                    </div>
                </div>

                <!-- Delete Room Action -->
                <div class="pt-10 mb-8 border-t border-gray-100">
                    <button
                        onclick={deleteRoom}
                        class="w-full py-5 bg-red-50 hover:bg-red-100 text-[#FF0033] text-sm font-black rounded-3xl transition-all border border-red-100 shadow-sm flex items-center justify-center gap-2 active:scale-95"
                    >
                        <svg
                            class="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2.5"
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                        </svg>
                        ルームを完全に削除して精算を終える
                    </button>
                </div>
            </section>
        {:else}
            {@const myTransaction = transactions.find(
                (t) => t.fromId === myParticipantId,
            )}
            {@const host = participants.find((p) => p.id === currentHostId)}

            <!-- GUEST VIEW: Payment Mission Card -->
            <section class="animate-fade-in space-y-8 py-4">
                {#if myTransaction}
                    <div
                        class="bg-white rounded-[3rem] shadow-[0_30px_70px_rgba(0,0,0,0.08)] border border-gray-100 p-10 flex flex-col items-center text-center gap-8"
                    >
                        <div class="space-y-2">
                            <span
                                class="text-gray-400 text-xs font-black uppercase tracking-[0.3em]"
                                >支払いミッション</span
                            >
                            <h2
                                class="text-3xl font-black text-gray-900 tracking-tight leading-tight"
                            >
                                <span class="text-indigo-600"
                                    >幹事（{myTransaction.toName}）</span
                                >へ<br />
                                <span
                                    class="text-6xl font-[1000] tracking-[-0.05em] block my-4 italic"
                                    >¥{myTransaction.amount.toLocaleString()}</span
                                >
                                支払う
                            </h2>
                        </div>

                        <!-- Payment Method Toggle for Guest -->
                        <div class="w-full max-w-[280px] space-y-2">
                            <span
                                class="text-[10px] text-gray-400 font-black uppercase tracking-widest"
                                >支払い方法を変更</span
                            >
                            <div
                                class="flex items-center rounded-2xl bg-gray-100 p-1"
                            >
                                <button
                                    onclick={() =>
                                        updateMyPaymentMethod("PayPay")}
                                    class="flex-1 py-3 text-sm font-black rounded-xl transition-all {myTransaction.method ===
                                    'PayPay'
                                        ? 'bg-white text-[#FF0033] shadow-sm'
                                        : 'text-gray-400'}"
                                >
                                    PayPay
                                </button>
                                <button
                                    onclick={() =>
                                        updateMyPaymentMethod("Cash")}
                                    class="flex-1 py-3 text-sm font-black rounded-xl transition-all {myTransaction.method ===
                                    'Cash'
                                        ? 'bg-white text-emerald-600 shadow-sm'
                                        : 'text-gray-400'}"
                                >
                                    現金
                                </button>
                            </div>
                        </div>

                        <div class="w-full space-y-3">
                            {#if myTransaction.method === "PayPay" && host?.paypayLink}
                                <button
                                    onclick={() =>
                                        handlePayPayClick(
                                            myTransaction.fromId,
                                            myTransaction.amount,
                                        )}
                                    class="w-full flex items-center justify-center gap-4 py-6 bg-[#FF0033] text-white text-xl font-black rounded-3xl hover:bg-[#E6002E] transition-all shadow-2xl shadow-[#FF0033]/30 active:scale-95 group"
                                >
                                    <svg
                                        class="w-8 h-8 group-hover:scale-110 transition-transform"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                    >
                                        <path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            stroke-width="2.5"
                                            d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                                        />
                                    </svg>
                                    PayPayで送金
                                </button>
                            {:else if myTransaction.method === "PayPay"}
                                <div
                                    class="p-6 bg-red-50 text-[#FF0033] rounded-3xl border border-red-100 flex flex-col items-center gap-2"
                                >
                                    <svg
                                        class="w-10 h-10"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                    >
                                        <path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            stroke-width="2"
                                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                                        />
                                    </svg>
                                    <p class="font-black">
                                        幹事のPayPayリンクが未設定です
                                    </p>
                                    <p class="text-xs font-bold opacity-70">
                                        幹事に設定を依頼してください。
                                    </p>
                                </div>
                            {:else}
                                <div
                                    class="p-8 bg-emerald-50 text-emerald-700 rounded-[2.5rem] border border-emerald-100 flex flex-col items-center gap-3"
                                >
                                    <svg
                                        class="w-12 h-12 text-emerald-400"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                    >
                                        <path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            stroke-width="2.5"
                                            d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm-5-2a2 2 0 11-4 0 2 2 0 014 0z"
                                        />
                                    </svg>
                                    <p class="text-2xl font-black">
                                        現金で手渡し
                                    </p>
                                    <p class="text-xs font-bold opacity-70">
                                        お釣りが出ないように準備しましょう
                                    </p>
                                </div>
                            {/if}

                            <div
                                class="w-full py-6 px-4 rounded-[2rem] bg-gray-50 border border-gray-100/50"
                            >
                                <p
                                    class="text-xs font-bold text-gray-500 leading-relaxed"
                                >
                                    ※ 送金（または手渡し）が終わったら、<br />
                                    幹事に伝えて完了ステータスにしてもらってください
                                </p>
                            </div>
                        </div>
                    </div>
                {:else}
                    <div
                        class="bg-white rounded-[3rem] shadow-[0_20px_50px_rgba(0,0,0,0.04)] border border-gray-100 p-12 flex flex-col items-center text-center gap-6"
                    >
                        <div
                            class="w-20 h-20 rounded-[2.5rem] bg-emerald-50 flex items-center justify-center text-emerald-500 mb-2"
                        >
                            <svg
                                class="w-10 h-10"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    stroke-width="3"
                                    d="M5 13l4 4L19 7"
                                />
                            </svg>
                        </div>
                        <h2
                            class="text-3xl font-black text-gray-900 tracking-tight leading-tight"
                        >
                            支払いはありません！
                        </h2>
                        <p class="text-gray-500 font-bold leading-relaxed">
                            あなたはぴったり、または精算不要です。<br />
                            快適な残りの時間をお過ごしください。
                        </p>
                    </div>
                {/if}

                {#if hostAbsorbedAmount > 0}
                    <div
                        class="bg-indigo-50/50 rounded-3xl p-6 border border-indigo-100/50 flex items-center justify-center gap-4"
                    >
                        <svg
                            class="w-8 h-8 text-indigo-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
                            />
                        </svg>
                        <p
                            class="text-xs font-bold text-indigo-700 leading-relaxed"
                        >
                            幹事が計 <span class="text-indigo-900 text-sm"
                                >¥{Math.round(
                                    hostAbsorbedAmount,
                                ).toLocaleString()}</span
                            >
                            の端数を<br />
                            被ってくれています。感謝しましょう！
                        </p>
                    </div>
                {/if}
            </section>
        {/if}
    </div>
</main>
