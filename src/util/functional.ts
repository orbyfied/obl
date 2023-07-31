/** Subscribe to the given function if it's subscribable
 *  Returns the listener object */
export function subscribe(func: Function, handler: (...args) => void): any {
    if (!func["listeners"]) return

    let listener = { handler: handler }
    func["listeners"].push(listener)
    return listener
}

/** Unsubscribe the given listener from the given subscribable */
export function unsubscribe(func: Function, listener: any) {
    if (!func["listeners"]) return

    let list = func["listeners"] as any[]
    list.splice(list.indexOf(listener), 1)
}

/** Marks a function as subscribable */
export function subscribable() {
    return function(target: Object, propertyKey: string) {
        let ogFunc = target[propertyKey]

        // create the decorated function
        let func: Function = function(...args) {
            ogFunc(...args)

            let listeners = func["listeners"] as any[]
            if (listeners) {
                listeners.forEach(l => l.handler(...args))
            }
        }

        func["listeners"] = []
        target[propertyKey] = func
    }
}

export function qp<T>(): QueuedOperation<T> {
    return new QueuedOperation()
}

/** The queued operation */
export class QueuedOperation<T> {
    func: () => T   // The function to run
    queued: boolean // Whether this operation is currently queued

    public set<T1>(func: () => T1): QueuedOperation<T1> {
        this.func = func as unknown as () => T
        return this as unknown as QueuedOperation<T1>
    }

    /** Call this operation */
    public call(): T {
        return this.func()
    }
}

/** A queue of operations to complete */
export class AsyncQueue {
    operations: (() => void)[] = []              // The list of operations

    /** Queue a new operation */
    public queue<T>(op: QueuedOperation<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            if (op.queued)
                return
            
            this.operations.push(() => {
                if (!op.queued)
                    return
                resolve(op.call())
                op.queued = false
            })

            op.queued = true
        })
    }

    /** Poll all queued operations */
    public pollAll(): (() => void)[] {
        let o = this.operations
        this.operations = []
        return o
    }

    /** Execute all queued operations */
    public executeAll() {
        this.pollAll().forEach(f => f())
    }

    /** Run an interval to poll all scheduled operations and execute them */
    public runInterval(delay: number): NodeJS.Timeout {
        return setInterval(() => {
            this.executeAll()
        }, delay)
    }

    public queueOptionally<T>(op: QueuedOperation<T>, queue: boolean): Promise<T> {
        if (!queue)
            return new Promise((resolve, reject) => resolve(op.call()))
        return this.queue(op).then(r => r)
    }
}