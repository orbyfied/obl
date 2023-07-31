/** Get an array of all super classes for the given prototype, 0 -> n in depth */
export function getSuperClasses(prototype): object[] {
    let list = []
    while (prototype != undefined) {
        list.push(prototype = Object.getPrototypeOf(prototype))
    }

    return list
}

/** Get an array of all super classes and the prototype itself for the given prototype, 0 -> n in depth */
export function getClassChain(prototype): object[] {
    let list = [prototype]
    while (prototype != undefined) {
        list.push(prototype = Object.getPrototypeOf(prototype))
    }

    return list
}

/** Check whether prototype 2 is assignable from prototype 1 */
export function isOfType(type1, type2) {
    return getSuperClasses(type1).findIndex(e => e == type2) != -1
}

/** Get the type name from the given prototype */
export function getPrototypeName(prototype: object) {
    if (!prototype)
        return null
    if (prototype["name"])
        return prototype["name"]
    return prototype.constructor.name
}

/** Get the class name of an object */
export function getPrototypeNameOfInstance(obj: Object) {
    return getPrototypeName(Object.getPrototypeOf(obj))
}

/** Evaluates the given javascript with */
export function evalWithScope(js, contextAsScope) {
    return function() { with(this) { return eval(js); }; }.call(contextAsScope);
}