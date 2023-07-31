/** Signals the absence of a value in an optional */
export class AbsentValueError extends Error {

}

/** Represents an optional value */
export abstract class Optional<T> {
    static present<T>(value: T): Optional<T> {
        return new ValueOptional<T>(value)
    }

    /** Checks whether the given value is defined, if so, it returns
     *  a present optional, otherwise an empty one*/
    static define<T>(value: T): Optional<T> {
        return value != undefined ? this.present(value) : this.empty()
    }

    /** Empty optional instance */
    protected static EMPTY: Optional<any>

    static empty<T>(): Optional<T> {
        return Optional.EMPTY as Optional<T>
    }

    /**
     * Check whether a value is present in this optional.
     */
    abstract isPresent(): boolean

    /**
     * Get the value stored, whether it is defined or not.
     * @returns The value or undefined if unset.
     */
    abstract get(): T

    createAbsentValueError(): AbsentValueError {
        return new AbsentValueError()
    }

    /**
     * Require a value to be set.
     * @throws AbsentValueError: When no value is set
     * @returns The value.
     */
    require(): T {
        if (!this.isPresent())
            throw this.createAbsentValueError()
        return this.get()
    }

    /**
     * Call the callback if a value is present.
     * @param then The callback.
     */
    ifPresent(then: (v: T) => void): Optional<T> {
        if (this.isPresent())
            then(this.get())
        return this
    }

    /** Get the value if present, else get the value from the supplier */
    orElseGet(supplier: () => T): T {
        if (this.isPresent())
            return this.get()
        return supplier()
    }

    /** Get the value if present, else return the default value */
    orElse(def: T): T {
        if (this.isPresent())
            return this.get()
        return def
    }

    /**
     * Create a mapped optional with this optional as 
     * a source.
     * @param func The mapping function.
     * @returns The mapped optional.
     */
    map<R>(func: (T) => R): Optional<R> {
        return new MappedOptional(this, func)
    }
}

/** Optional implementation with a value set */
class ValueOptional<T> extends Optional<T> {
    value: T // The value stored

    constructor(value: T) {
        super()
        this.value = value;
    }

    override isPresent(): boolean {
        return true
    }

    override get(): T {
        return this.value
    }
}

/** Optional implementation with no value set */
class EmptyOptional extends Optional<any> {
    static {
        Optional.EMPTY = new EmptyOptional()
    }

    override isPresent(): boolean {
        return false
    }

    override get(): any {
        return undefined
    }
}

/** Optional implementation mapped from a source */
class MappedOptional<T, R> extends Optional<R> {
    source: Optional<T> // The source optional
    mapper: (T) => R    // The mapping function

    constructor(source: Optional<T>, mapper: (T) => R) {
        super()
        this.source = source
        this.mapper = mapper
    }

    isPresent(): boolean {
        return this.source.isPresent()
    }

    get(): R {
        return this.mapper(this.source.get())
    }
}

// Object#toOptional()
Object.prototype["toOptional"] = (v) => Optional.present(v)