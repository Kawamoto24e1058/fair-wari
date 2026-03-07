<script lang="ts">
    import { goto } from "$app/navigation";
    import { db } from "$lib/firebase/firebase";
    import { doc, setDoc, serverTimestamp } from "firebase/firestore";
    import { v4 as uuidv4 } from "uuid";

    let isCreating = $state(false);

    async function createRoom() {
        if (isCreating) return;
        isCreating = true;
        try {
            const roomId = uuidv4();
            const roomRef = doc(db, "rooms", roomId);

            // Create initial state
            await setDoc(roomRef, {
                id: roomId,
                createdAt: serverTimestamp(),
                state: {
                    participants: [],
                    events: [],
                    roundMode: "nearest",
                },
                settlements: {},
            });

            await goto(`/room/${roomId}`);
        } catch (error) {
            console.error("Error creating room:", error);
            alert("ルームの作成に失敗しました。詳細: " + error);
            isCreating = false;
        }
    }
</script>

<svelte:head>
    <title>最強の割り勘アプリ - ルーム作成</title>
</svelte:head>

<main
    class="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4"
>
    <div
        class="max-w-md w-full bg-white rounded-3xl shadow-xl overflow-hidden border border-gray-100 p-8 text-center"
    >
        <div
            class="w-16 h-16 bg-indigo-100 text-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-6"
        >
            <svg
                class="w-8 h-8"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
            >
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                ></path>
            </svg>
        </div>

        <h1
            class="text-3xl font-extrabold text-gray-900 mb-3 tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-primary-600 to-indigo-600"
        >
            最強の割り勘アプリ
        </h1>
        <p class="text-gray-500 mb-8 font-medium">
            URLをシェアするだけで、<br />
            みんなのスマホでリアルタイムに計算！
        </p>

        <button
            onclick={createRoom}
            disabled={isCreating}
            class="w-full bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white font-bold py-4 rounded-2xl shadow-lg shadow-indigo-600/30 transition-all transform hover:-translate-y-1 active:scale-95 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
        >
            {#if isCreating}
                <svg
                    class="animate-spin -ml-1 mr-2 h-5 w-5 text-white"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                >
                    <circle
                        class="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        stroke-width="4"
                    ></circle>
                    <path
                        class="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                </svg>
                ルームを作成中...
            {:else}
                <svg
                    class="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                    ></path>
                </svg>
                新しく割り勘ルームを作る
            {/if}
        </button>
    </div>
</main>
