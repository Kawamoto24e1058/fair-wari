<script lang="ts">
    import { goto } from "$app/navigation";
    import { db } from "$lib/firebase/firebase";
    import {
        doc,
        setDoc,
        getDoc,
        serverTimestamp,
        collection,
        query,
        where,
        getDocs,
        GeoPoint,
    } from "firebase/firestore";

    let isCreating = $state(false);
    let customRoomId = $state("");
    let joinPin = $state("");
    let isJoining = $state(false);
    let isSearching = $state(false);
    let searchError = $state("");
    let nearbyRooms = $state<{ id: string; distance: number }[]>([]);

    async function getGeolocation(): Promise<GeolocationPosition> {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject(
                    new Error("お使いのブラウザは位置情報に対応していません。"),
                );
            } else {
                navigator.geolocation.getCurrentPosition(resolve, reject, {
                    enableHighAccuracy: true,
                    timeout: 10000,
                    maximumAge: 0,
                });
            }
        });
    }

    // ハーベサインの公式（距離計算）
    function calculateDistance(
        lat1: number,
        lon1: number,
        lat2: number,
        lon2: number,
    ) {
        const R = 6371e3; // meters
        const phi1 = (lat1 * Math.PI) / 180;
        const phi2 = (lat2 * Math.PI) / 180;
        const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
        const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

        const a =
            Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
            Math.cos(phi1) *
                Math.cos(phi2) *
                Math.sin(deltaLambda / 2) *
                Math.sin(deltaLambda / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c; // in meters
    }

    async function createRoom() {
        if (isCreating) return;

        const validIdRegex = /^[a-zA-Z0-9\-]{3,}$/;
        if (!validIdRegex.test(customRoomId)) {
            alert(
                "合言葉は半角英数字およびハイフンで、3文字以上入力してください。",
            );
            return;
        }

        isCreating = true;

        let position: GeolocationPosition | null = null;
        try {
            position = await getGeolocation();
        } catch (e: any) {
            console.warn(
                "位置情報の取得に失敗しました。位置情報なしで作成します。",
                e,
            );
        }

        try {
            const roomRef = doc(db, "rooms", customRoomId);
            const snap = await getDoc(roomRef);

            if (snap.exists() && snap.data().status === "active") {
                alert(
                    "この合言葉は現在他の人が使用中です。別の合言葉にしてください。",
                );
                isCreating = false;
                return;
            }

            const roomId = customRoomId;

            const locationObj = position
                ? new GeoPoint(
                      position.coords.latitude,
                      position.coords.longitude,
                  )
                : null;

            const expirationDate = new Date();
            expirationDate.setHours(expirationDate.getHours() + 1);

            await setDoc(roomRef, {
                id: roomId,
                createdAt: serverTimestamp(),
                expiresAt: expirationDate,
                status: "active",
                location: locationObj,
                state: {
                    participants: [],
                    events: [],
                    roundMode: "nearest",
                },
                settlements: {},
            });

            await goto(`/room/${roomId}`);
        } catch (error: any) {
            console.error("Error creating room:", error);
            alert("ルームの作成に失敗しました。詳細: " + error.message);
            isCreating = false;
        }
    }

    async function joinByPin(e?: Event) {
        if (e) e.preventDefault();
        if (!joinPin.trim()) {
            alert("合言葉を入力してください。");
            return;
        }
        if (isJoining) return;
        isJoining = true;

        try {
            const snap = await getDoc(doc(db, "rooms", joinPin));
            if (snap.exists() && snap.data().status === "active") {
                await goto(`/room/${joinPin}`);
            } else {
                alert("ルームが見つからないか、既に終了しています。");
                isJoining = false;
            }
        } catch (error: any) {
            console.error("Error joining room:", error);
            alert("エラーが発生しました: " + error.message);
            isJoining = false;
        }
    }

    async function searchNearbyRooms() {
        if (isSearching) return;
        isSearching = true;
        searchError = "";
        nearbyRooms = [];

        try {
            const position = await getGeolocation();
            const currentLat = position.coords.latitude;
            const currentLon = position.coords.longitude;

            const q = query(
                collection(db, "rooms"),
                where("status", "==", "active"),
            );
            const querySnapshot = await getDocs(q);

            const rooms: { id: string; distance: number }[] = [];
            querySnapshot.forEach((docSnap) => {
                const data = docSnap.data();
                if (data.location) {
                    const lat = data.location.latitude;
                    const lon = data.location.longitude;
                    const distance = calculateDistance(
                        currentLat,
                        currentLon,
                        lat,
                        lon,
                    );

                    if (distance <= 100) {
                        // 100m以内のルーム
                        rooms.push({
                            id: data.id,
                            distance: Math.round(distance),
                        });
                    }
                }
            });

            rooms.sort((a, b) => a.distance - b.distance);
            nearbyRooms = rooms;

            if (rooms.length === 0) {
                searchError =
                    "近く(約100m以内)にアクティブなルームが見つかりませんでした。合言葉を入力してください。";
            }
        } catch (e: any) {
            console.error("Search error:", e);
            searchError =
                "位置情報の取得に失敗しました。手動で合言葉を入力してください。";
        } finally {
            isSearching = false;
        }
    }
</script>

<svelte:head>
    <title>最強の割り勘アプリ - トップ</title>
</svelte:head>

<main
    class="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4"
>
    <div
        class="max-w-md w-full bg-white rounded-3xl shadow-xl overflow-hidden border border-gray-100 p-8"
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
            class="text-3xl font-extrabold text-gray-900 mb-3 tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-primary-600 to-indigo-600 text-center"
        >
            最強の割り勘アプリ
        </h1>
        <p class="text-gray-500 mb-8 font-medium text-center text-sm">
            URL共有やGPS、オリジナルの合言葉で<br />
            みんなのスマホでリアルタイムに計算！
        </p>

        <!-- Room Creation (Host) -->
        <div class="mb-8 pb-8 border-b border-gray-100">
            <div class="mb-4">
                <label
                    for="customRoomId"
                    class="block text-xs font-bold text-gray-500 mb-1 text-left"
                    >合言葉 (ルームID)<span class="text-red-500 ml-1">*</span
                    ></label
                >
                <input
                    id="customRoomId"
                    type="text"
                    bind:value={customRoomId}
                    placeholder="例: my-room-123 (半角英数字ハイフン)"
                    class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 text-sm font-bold outline-none"
                    disabled={isCreating}
                />
            </div>

            <button
                onclick={createRoom}
                disabled={isCreating || customRoomId.length < 3}
                class="w-full bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white font-bold py-4 rounded-2xl shadow-lg shadow-indigo-600/30 transition-all transform hover:-translate-y-1 active:scale-95 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
            >
                {#if isCreating}
                    <svg
                        class="animate-spin h-5 w-5 text-white"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        ><circle
                            class="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            stroke-width="4"
                        ></circle><path
                            class="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        ></path></svg
                    >
                    ルームを作成中...
                {:else}
                    <svg
                        class="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        ><path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                        ></path></svg
                    >
                    新しく割り勘ルームを作る
                {/if}
            </button>
            <p class="text-[10px] text-gray-400 text-center mt-3">
                作成時に現在の位置情報を保存します（近くの人への共有用）
            </p>
        </div>

        <!-- Room Join (Guest) -->
        <div class="space-y-6">
            <h2 class="text-lg font-bold text-gray-800 text-center">
                ルームに参加する
            </h2>

            <!-- Search Nearby -->
            <div>
                <button
                    onclick={searchNearbyRooms}
                    disabled={isSearching}
                    class="w-full bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold py-3 px-4 rounded-xl transition-colors flex items-center justify-center gap-2 border border-emerald-200"
                >
                    {#if isSearching}
                        <svg
                            class="animate-spin h-5 w-5"
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            ><circle
                                class="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                stroke-width="4"
                            ></circle><path
                                class="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            ></path></svg
                        >
                        近くのルームを探しています...
                    {:else}
                        <svg
                            class="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            ><path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                            ></path><path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                            ></path></svg
                        >
                        GPSで近くのルームを探す
                    {/if}
                </button>

                {#if searchError}
                    <p class="text-xs text-red-500 mt-2 text-center">
                        {searchError}
                    </p>
                {/if}

                {#if nearbyRooms.length > 0}
                    <div class="mt-4 space-y-2">
                        <p class="text-xs font-bold text-gray-500 mb-2">
                            見つかったルーム (100m以内)
                        </p>
                        {#each nearbyRooms as room}
                            <a
                                href={`/room/${room.id}`}
                                class="flex items-center justify-between bg-white border border-emerald-200 p-3 rounded-lg hover:bg-emerald-50 transition-colors shadow-sm"
                            >
                                <div class="flex items-center gap-2">
                                    <span class="text-emerald-500 font-bold"
                                        >合言葉: {room.id}</span
                                    >
                                </div>
                                <span class="text-xs text-gray-400"
                                    >約 {room.distance}m</span
                                >
                            </a>
                        {/each}
                    </div>
                {/if}
            </div>

            <div class="relative flex items-center py-2">
                <div class="flex-grow border-t border-gray-200"></div>
                <span class="flex-shrink-0 mx-4 text-gray-400 text-xs font-bold"
                    >または</span
                >
                <div class="flex-grow border-t border-gray-200"></div>
            </div>

            <!-- Manually enter PIN -->
            <form onsubmit={joinByPin} class="flex gap-2">
                <input
                    type="text"
                    bind:value={joinPin}
                    placeholder="合言葉を入力"
                    class="flex-1 px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 text-center text-sm sm:text-lg font-bold outline-none"
                    disabled={isJoining}
                />
                <button
                    type="submit"
                    disabled={isJoining || !joinPin.trim()}
                    class="bg-gray-800 hover:bg-gray-900 text-white px-6 py-3 rounded-xl font-bold transition-colors disabled:opacity-50"
                >
                    参加
                </button>
            </form>
        </div>
    </div>
</main>
