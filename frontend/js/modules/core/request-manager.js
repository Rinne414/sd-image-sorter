(function initRequestManager(global) {
    global.RequestManager = {
        pendingRequests: new Map(),
        requestId: 0,

        createAbortController(key) {
            this.cancel(key);
            const controller = new AbortController();
            this.pendingRequests.set(key, controller);
            return controller;
        },

        cancel(key) {
            const controller = this.pendingRequests.get(key);
            if (controller) {
                controller.abort();
                this.pendingRequests.delete(key);
            }
        },

        cancelAll() {
            this.pendingRequests.forEach((controller) => controller.abort());
            this.pendingRequests.clear();
        },

        complete(key, controller = null) {
            if (!controller || this.pendingRequests.get(key) === controller) {
                this.pendingRequests.delete(key);
            }
        },

        isAbortedError(error) {
            return error.name === 'AbortError';
        }
    };
})(window);

