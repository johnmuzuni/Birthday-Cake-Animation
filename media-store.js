/* ============================================================
   Shared media hand-off for the birthday reel
   Photos and the 10-second song are stored in IndexedDB so the
   upload page can pass them to the reel page.
============================================================ */
(() => {
  'use strict';

  const DB_NAME = 'birthday-reel';
  const DB_VERSION = 1;
  const STORE = 'media';
  const KEY = 'current';

  let dbPromise = null;

  function openDb() {
    if (!('indexedDB' in window)) {
      return Promise.reject(new Error('IndexedDB is not available'));
    }

    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE);
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Could not open storage'));
        request.onblocked = () => reject(new Error('Storage is blocked'));
      }).catch((error) => {
        dbPromise = null;
        throw error;
      });
    }

    return dbPromise;
  }

  function save(record) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record, KEY);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error || new Error('Could not save the reel'));
      tx.onabort = () => reject(tx.error || new Error('Saving the reel was cancelled'));
    }));
  }

  function load() {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Could not read the reel'));
    }));
  }

  function clear() {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Could not clear the reel'));
    }));
  }

  window.MediaStore = { save, load, clear };
})();
