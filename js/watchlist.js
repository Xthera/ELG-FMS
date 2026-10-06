/* ============================================================
   ELG FMS — WATCHLIST
   ============================================================
   The funds a viewer is watching, saved in this browser.
   Shared by Monitoring and the Fund Explorer profile popup.
   ============================================================ */

const STORAGE_KEY = "vgrat-fms-watchlist";

const listeners = new Set();

let cache = null;


function read() {
    if (cache) return cache;

    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");

        cache = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        cache = [];
    }

    return cache;
}

function write(ids) {
    cache = [...new Set(ids.map(String))];

    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch {
        // Ignore storage failures; the list still works this session.
    }

    for (const listener of listeners) {
        try {
            listener(getWatchlist());
        } catch (error) {
            console.warn("ELG FMS: watchlist listener failed.", error);
        }
    }
}

function getWatchlist() {
    return [...read()];
}

function isWatched(id) {
    return read().includes(String(id));
}

function addToWatchlist(id) {
    if (!isWatched(id)) write([...read(), String(id)]);
}

function removeFromWatchlist(id) {
    write(read().filter(item => item !== String(id)));
}

function toggleWatchlist(id) {
    if (isWatched(id)) removeFromWatchlist(id);
    else addToWatchlist(id);

    return isWatched(id);
}

function onWatchlistChange(listener) {
    listeners.add(listener);

    return () => listeners.delete(listener);
}


export {
    getWatchlist,
    isWatched,
    addToWatchlist,
    removeFromWatchlist,
    toggleWatchlist,
    onWatchlistChange
};
