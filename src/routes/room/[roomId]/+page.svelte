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

    let showIdentityModal = $state(false);
    let newParticipantName = $state("");
    let newParticipantMethod = $state<"PayPay" | "Cash">("PayPay");

    let showQrModal = $state(false);
    let qrDataUrl = $state("");

    let toastMessage = $state("");
    let showToast = $state(false);

    let unsubscribe: (() => void) | undefined;

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
                if (data.hostId && myParticipantId) {
                    isHost = data.hostId === myParticipantId;
                    localStorage.setItem(
                        `room_${roomId}_identity`,
                        JSON.stringify({
                            participantId: myParticipantId,
                            isHost: isHost,
                        }),
                    );
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
        const state: AppState = { participants, events, roundMode };
        const res = calculateNetBalances(state);
        balances = res.balances;
        transactions = res.transactions;
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

    async function handlePayPayClick(fromId: string, amount: number) {
        if (myParticipantId === fromId) {
            settlements[fromId] = true;
            saveStateToFirebase();
        }

        try {
            await navigator.clipboard.writeText(amount.toString());
            showToastNotification(
                `${amount.toLocaleString()}円をコピーしました！PayPayでペーストしてください。`,
            );
        } catch (err) {
            console.error("Failed to copy amount", err);
            showToastNotification("別タブでPayPayを開きます。");
        }
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
</script>

<svelte:head>
    <title>最強の割り勘アプリ - ルーム</title>
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
                            class="px-2 py-0.5 bg-indigo-100 text-indigo-700 text-[10px] font-black uppercase rounded-lg"
                            >Host</span
                        >
                    {:else if myParticipantId}
                        <span
                            class="px-2 py-0.5 bg-gray-100 text-gray-600 text-[10px] font-black uppercase rounded-lg"
                            >Guest</span
                        >
                    {/if}
                </h1>
                <p class="text-xs md:text-sm text-gray-500 font-medium mt-1">
                    リアルタイム共有ルーム
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

    <div class="max-w-7xl mx-auto px-4 py-8">
        <div class="grid grid-cols-1 xl:grid-cols-12 gap-8">
            <!-- Left Column: Participants & Settings -->
            <div class="xl:col-span-3 space-y-6">
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
                                                class="text-[10px] text-indigo-600 hover:text-white hover:bg-indigo-500 bg-indigo-50 px-2 py-2 rounded-lg transition-colors font-bold whitespace-nowrap shadow-sm border border-indigo-100"
                                                title="この人に幹事を渡す"
                                            >
                                                👑幹事に任命
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
                            <option value="nearest">💰 普通に四捨五入</option>
                            <option value="down">📉 払い・受取りを少なく</option
                            >
                            <option value="up">📈 払い・受取りを多く</option>
                        </select>
                    </div>
                </section>
            </div>

            <!-- Middle Column: Events (Receipts) -->
            <div class="xl:col-span-5 space-y-6">
                <div class="flex items-center justify-between">
                    <h2
                        class="text-xl font-bold text-gray-800 flex items-center gap-2"
                    >
                        <svg
                            class="w-6 h-6 text-indigo-500"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            ><path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                            ></path></svg
                        >
                        レシート・支払い履歴
                    </h2>
                    {#if isHost}
                        <button
                            onclick={addEvent}
                            class="px-4 py-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-bold rounded-xl transition-colors flex items-center gap-2 text-sm shadow-sm"
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
                                    d="M12 4v16m8-8H4"
                                ></path></svg
                            >
                            追加
                        </button>
                    {/if}
                </div>

                <div class="space-y-5">
                    {#each events as event (event.id)}
                        <article
                            class="bg-white rounded-3xl shadow-sm border border-gray-200 overflow-hidden group"
                        >
                            <div
                                class="p-5 border-b border-gray-100 bg-gray-50/50 flex justify-between items-start gap-4"
                            >
                                <div class="flex-1 space-y-3">
                                    <input
                                        type="text"
                                        bind:value={event.title}
                                        oninput={saveAndRecalculate}
                                        disabled={!isHost}
                                        class="w-full px-0 py-1 border-transparent bg-transparent focus:ring-0 text-lg font-bold text-gray-800 placeholder-gray-400 disabled:opacity-80"
                                        placeholder="何代？ (例: 居酒屋、タクシー)"
                                    />

                                    <div class="flex items-center gap-3">
                                        <div class="relative flex-1">
                                            <span
                                                class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 font-bold"
                                                >¥</span
                                            >
                                            <input
                                                type="number"
                                                bind:value={event.amount}
                                                oninput={saveAndRecalculate}
                                                disabled={!isHost}
                                                class="w-full pl-8 pr-3 py-2.5 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-500 text-lg font-black text-gray-900 shadow-sm disabled:bg-gray-50"
                                                placeholder="0"
                                            />
                                        </div>
                                        <div
                                            class="flex items-center gap-2 min-w-[120px]"
                                        >
                                            <span
                                                class="text-xs font-bold text-gray-400 uppercase"
                                                >支払った人</span
                                            >
                                            <select
                                                bind:value={event.payerId}
                                                onchange={saveAndRecalculate}
                                                disabled={!isHost}
                                                class="w-full px-2 py-2.5 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-500 text-sm font-bold text-gray-700 shadow-sm disabled:bg-gray-50"
                                            >
                                                {#each participants as p}
                                                    <option value={p.id}
                                                        >{p.name}</option
                                                    >
                                                {/each}
                                            </select>
                                        </div>
                                    </div>
                                </div>
                                {#if isHost}
                                    <button
                                        aria-label="削除"
                                        onclick={() => removeEvent(event.id)}
                                        class="text-gray-300 hover:text-red-500 p-2 bg-white rounded-full border border-gray-200 shadow-sm transition-colors opacity-0 group-hover:opacity-100"
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
                            </div>

                            <div class="px-5 pb-5">
                                <details class="group">
                                    <summary
                                        class="flex items-center justify-between cursor-pointer list-none text-xs font-bold text-gray-500 uppercase tracking-wider py-3 border-t border-gray-100 mt-2"
                                    >
                                        <div class="flex items-center gap-2">
                                            <span>詳細な割り勘設定を開く</span>
                                            <svg
                                                class="w-4 h-4 transform transition-transform group-open:rotate-180"
                                                fill="none"
                                                stroke="currentColor"
                                                viewBox="0 0 24 24"
                                                ><path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    stroke-width="2"
                                                    d="M19 9l-7 7-7-7"
                                                ></path></svg
                                            >
                                        </div>
                                        <div
                                            class="flex-1 h-px bg-gray-100 ml-3"
                                        ></div>
                                    </summary>

                                    <div class="pt-2 space-y-2">
                                        {#each participants as part}
                                            {@const isParticipating =
                                                event.participations.some(
                                                    (ep) =>
                                                        ep.participantId ===
                                                        part.id,
                                                )}
                                            <div
                                                class="flex items-center justify-between p-3 rounded-xl {isParticipating
                                                    ? 'bg-white border border-indigo-100 shadow-sm'
                                                    : 'bg-gray-50 border border-transparent'} transition-all"
                                            >
                                                <div
                                                    class="flex items-center gap-3 w-1/3"
                                                >
                                                    <label
                                                        class="relative inline-flex items-center {isHost
                                                            ? 'cursor-pointer'
                                                            : 'cursor-not-allowed'}"
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            class="sr-only peer"
                                                            checked={isParticipating}
                                                            disabled={!isHost}
                                                            onchange={(e) => {
                                                                if (
                                                                    e
                                                                        .currentTarget
                                                                        .checked
                                                                ) {
                                                                    event.participations.push(
                                                                        {
                                                                            participantId:
                                                                                part.id,
                                                                            weight: 1,
                                                                            fixedAdjustment: 0,
                                                                        },
                                                                    );
                                                                } else {
                                                                    event.participations =
                                                                        event.participations.filter(
                                                                            (
                                                                                ep,
                                                                            ) =>
                                                                                ep.participantId !==
                                                                                part.id,
                                                                        );
                                                                }
                                                                saveAndRecalculate();
                                                            }}
                                                        />
                                                        <div
                                                            class="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-500 peer-disabled:opacity-50"
                                                        ></div>
                                                    </label>
                                                    <span
                                                        class="text-sm font-bold {isParticipating
                                                            ? 'text-gray-800'
                                                            : 'text-gray-400'} truncate"
                                                        >{part.name}</span
                                                    >
                                                </div>

                                                {#if isParticipating}
                                                    {@const ep =
                                                        event.participations.find(
                                                            (ep) =>
                                                                ep.participantId ===
                                                                part.id,
                                                        )}
                                                    {#if ep}
                                                        <div
                                                            class="flex items-center gap-3 w-2/3 justify-end animate-fade-in"
                                                        >
                                                            <div
                                                                class="flex flex-col"
                                                            >
                                                                <label
                                                                    class="text-[10px] text-gray-500 font-bold mb-0.5"
                                                                    for="w-{event.id}-{part.id}"
                                                                    >負担比率</label
                                                                >
                                                                <input
                                                                    id="w-{event.id}-{part.id}"
                                                                    type="number"
                                                                    step="0.1"
                                                                    bind:value={
                                                                        ep.weight
                                                                    }
                                                                    oninput={saveAndRecalculate}
                                                                    disabled={!isHost}
                                                                    class="w-16 px-2 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-bold text-center focus:ring-2 focus:ring-indigo-500 transition-shadow disabled:bg-gray-100"
                                                                    min="0"
                                                                />
                                                            </div>
                                                            <div
                                                                class="flex flex-col"
                                                            >
                                                                <label
                                                                    class="text-[10px] text-gray-500 font-bold mb-0.5"
                                                                    for="f-{event.id}-{part.id}"
                                                                    >割引・追加金額(円)</label
                                                                >
                                                                <input
                                                                    id="f-{event.id}-{part.id}"
                                                                    type="number"
                                                                    bind:value={
                                                                        ep.fixedAdjustment
                                                                    }
                                                                    oninput={saveAndRecalculate}
                                                                    disabled={!isHost}
                                                                    class="w-24 px-2 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-bold text-center focus:ring-2 focus:ring-indigo-500 transition-shadow disabled:bg-gray-100"
                                                                    placeholder="0"
                                                                />
                                                            </div>
                                                        </div>
                                                    {/if}
                                                {/if}
                                            </div>
                                        {/each}
                                    </div>
                                </details>
                            </div>
                        </article>
                    {/each}
                    {#if events.length === 0}
                        <div
                            class="text-center py-10 bg-white rounded-3xl border border-dashed border-gray-300 text-gray-400"
                        >
                            まだレシートがありません。
                        </div>
                    {/if}
                </div>

                {#if isHost}
                    <div class="pt-4">
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

            <!-- Right Column: Results & Settlements -->
            <div class="xl:col-span-4 space-y-6">
                <div
                    class="bg-gradient-to-b from-indigo-900 to-indigo-800 rounded-3xl shadow-xl overflow-hidden border border-indigo-700 text-white sticky top-24"
                >
                    <div class="p-6 md:p-8">
                        <h2
                            class="text-2xl font-bold mb-6 flex items-center gap-3"
                        >
                            <div
                                class="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-indigo-300"
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
                                        d="M13 10V3L4 14h7v7l9-11h-7z"
                                    ></path></svg
                                >
                            </div>
                            最終精算
                        </h2>

                        <div class="space-y-6">
                            <div>
                                <h3
                                    class="text-xs font-bold text-indigo-300 mb-3 uppercase tracking-wider"
                                >
                                    誰が誰に払うか
                                </h3>
                                <div class="space-y-3">
                                    {#if transactions.length === 0}
                                        <div
                                            class="bg-white/5 rounded-xl p-6 text-center text-indigo-200 text-sm border border-white/10"
                                        >
                                            精算が必要なトランザクションはありません。<br
                                            />（みんなぴったりです！）
                                        </div>
                                    {:else}
                                        {#each transactions as t}
                                            <div
                                                class="bg-white rounded-2xl p-4 shadow-lg text-gray-900 border border-white/20 transform transition hover:-translate-y-1"
                                            >
                                                <div
                                                    class="flex items-center justify-between mb-3"
                                                >
                                                    <div
                                                        class="flex items-center gap-3 flex-1 overflow-hidden"
                                                    >
                                                        <div
                                                            class="font-bold truncate text-sm"
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
                                                            class="font-bold text-gray-600 truncate text-sm"
                                                        >
                                                            {t.toName}
                                                        </div>
                                                    </div>
                                                </div>
                                                <div
                                                    class="flex items-end justify-between border-b border-gray-100 pb-3 mb-3"
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
                                                        class="text-2xl font-black tracking-tight"
                                                        >¥{t.amount.toLocaleString()}</span
                                                    >
                                                </div>

                                                {#if t.method === "PayPay" && t.toPaypayId}
                                                    <div class="mt-2">
                                                        {@const paypayLink =
                                                            t.toPaypayId.startsWith(
                                                                "http",
                                                            ) ||
                                                            t.toPaypayId.startsWith(
                                                                "paypay://",
                                                            )
                                                                ? t.toPaypayId
                                                                : `paypay://send?userNum=${t.toPaypayId}&amount=${t.amount}`}
                                                        <a
                                                            href={paypayLink}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            onclick={() =>
                                                                handlePayPayClick(
                                                                    t.fromId,
                                                                    t.amount,
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
                                                        </a>
                                                    </div>
                                                {/if}
                                            </div>
                                        {/each}
                                    {/if}
                                </div>
                            </div>

                            <div class="pt-6 border-t border-indigo-700/50">
                                <h3
                                    class="text-xs font-bold text-indigo-300 mb-4 uppercase tracking-wider"
                                >
                                    個人のトータル収支
                                </h3>
                                <div
                                    class="grid grid-cols-2 sm:grid-cols-3 gap-3"
                                >
                                    {#each balances as r}
                                        <div
                                            class="bg-indigo-800/50 p-3 rounded-xl border border-indigo-700/50 flex flex-col items-center text-center relative {r.participantId ===
                                            myParticipantId
                                                ? 'ring-2 ring-indigo-400 shadow-lg shadow-indigo-500/50'
                                                : ''}"
                                        >
                                            {#if r.participantId === myParticipantId}
                                                <span
                                                    class="absolute -top-2 bg-indigo-500 text-white text-[9px] font-black px-2 py-0.5 rounded-full z-10"
                                                    >YOU</span
                                                >
                                            {/if}
                                            <span
                                                class="text-xs font-medium text-indigo-200 mb-1 w-full truncate"
                                                >{r.name}</span
                                            >
                                            <span
                                                class="text-lg font-bold {r.roundedBalance >
                                                0
                                                    ? 'text-emerald-400'
                                                    : r.roundedBalance < 0
                                                      ? 'text-red-400'
                                                      : 'text-gray-400'}"
                                            >
                                                {r.roundedBalance > 0
                                                    ? "+"
                                                    : ""}{r.roundedBalance.toLocaleString()}
                                            </span>
                                            <span
                                                class="text-[9px] mt-1 text-indigo-400/70"
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
                                                class="mt-3 w-full py-1.5 text-xs font-bold rounded-lg transition-colors border {settlements[
                                                    r.participantId
                                                ]
                                                    ? 'bg-emerald-500 text-white border-emerald-400'
                                                    : 'bg-white/10 text-indigo-200 border-white/20 hover:bg-white/20 disabled:opacity-50 disabled:hover:bg-white/10'}"
                                            >
                                                {settlements[r.participantId]
                                                    ? "✅ 支払済"
                                                    : "未完了"}
                                            </button>
                                        </div>
                                    {/each}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</main>
