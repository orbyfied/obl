import { logtrace } from "./logging";
import { Optional } from "./optional";

/** A future, can be used as an event/callback list */
export class Future<V> {
    constructor() { }

    private anyHandlers: ((V, Error) => void)[] = [] // Any result handlers
    private errHandlers: ((Error) => void)[]    = [] // Error handlers
    private valHandlers: ((V) => void)[]        = [] // Value/success handlers
    private ovlHandlers: ((V) => void)[]        = [] // Value/success handlers (once)
    
    private hasValue: boolean = false
    private value: V = undefined
    private error: Error = null

    /**
     * Add a callback/handler to this future.
     * This callback will be called for both success and failure.
     * @param callback The callback to register.
     */
    then(callback: (V, Error) => void): Future<V> {
        this.anyHandlers.push(callback)
        return this
    }

    /**
     * Add a callback/handler for errors to this future.
     * @param callback The callback to register.
     */
    exceptionally(callback: (Error) => void): Future<V> {
        this.errHandlers.push(callback)
        return this
    }

    /**
     * Add a callback/handler for success to this future.
     * @param callback The callback to register.
     */
    completed(callback: (V) => void): Future<V> {
        this.valHandlers.push(callback)
        return this
    }

    /**
     * Add a callback/handler for success to this future which
     * will be removed after one call.
     * @param callback The callback to register.
     */
    once(callback: (V) => void): Future<V> {
        this.ovlHandlers.push(callback)
        return this
    }

    /**
     * Get the current state of this future.
     * The optionals value will be absent if the future
     * has not completed successfully yet.
     * @returns The value optional.
     */
    get(): Optional<V> {
        if (!this.hasValue) {
            return Optional.empty()
        }

        return Optional.present(this.value)
    }

    /**
     * Get the error if present.
     * @returns The error optional.
     */
    getError(): Optional<Error> {
        if (!this.error) {
            return Optional.empty()
        }

        return Optional.present(this.error)
    }

    /**
     * Complete successfully.
     * @param value The value.
     */
    complete(value: V) {
        this.hasValue = true
        this.value = value
        this.error = null

        if (this.anyHandlers.length != 0) { this.anyHandlers.forEach(f => f(value, null)) }
        if (this.valHandlers.length != 0) { this.valHandlers.forEach(f => f(value)) }
        if (this.ovlHandlers.length != 0) { this.ovlHandlers.forEach(f => f(value)); this.ovlHandlers = [] }
    }

    /**
     * Complete unsuccessfully.
     * @param error The error
     */
    fail(error: Error) {  
        this.hasValue = false
        this.value = undefined
        this.error = error

        this.anyHandlers.forEach(f => f(undefined, error))
        this.errHandlers.forEach(f => f(error))
    }

    /**
     * Map this future to another.
     * @param f The mapping function.
     */
    map<R>(f: (V) => R) {
        throw new Error("TODO")
    }
}

const oldThen = Promise.prototype.then
export function enablePromiseDebug() {
    // Promise.then
    if (Promise.prototype.then === oldThen) {
        Promise.prototype.then = function (h, r) {
            var id = Date.now()
            logtrace("Promise THEN id(", id, "), h: ", h, ", r: ", r)
            return oldThen.apply(this, [/* onfulfill */ function(v) {
                logtrace("Promise CALL id(", id, "), v: " + v, ", h: ", h)
                if (h) {
                    return h(v)
                }
            }, r])
        } as any
    }
}

/** Create a completed promise */
export function completedPromise<T>(v: T): Promise<T> {
    return Promise.resolve(v)
}