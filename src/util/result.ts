/** Stores the result of an operation */
export class Result<R> {
    public static success<R>(value: R) {
        return new Result<R>(null, value)
    }

    public static fail<R>(error: Error) {
        return new Result<R>(error, undefined)
    }

    error: Error // The error if it was thrown
    value: R     // The return value

    private constructor(error: Error, value: R) {
        this.error = error
        this.value = value
    }

    // todo //
}

/** Calls the given function returning the result object of the call */
export function pcall<R>(func: (...any) => R, thisInstance: any, ...args: any[]): Result<R> {
    try {
        return Result.success(func.call(thisInstance, ...args))
    } catch (e) {
        return Result.fail(e)
    }
}

/** Calls the given function async returning the result object of the call */
export function pcallAsync<R>(func: (...any) => R, thisInstance: any, ...args: any[]): Promise<Result<R>> {
    return new Promise((resolve, reject) => {
        try {
            resolve(func.call(thisInstance, ...args))
        } catch (e) {
            reject(e)
        }
    })
}