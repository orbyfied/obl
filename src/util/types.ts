/** Remove all elements provided by the given iterable from the array */
export function removeAll<T>(arr: Array<T>, toRemove: Iterable<T>): Array<T> {
    for (let rem of toRemove) {
        arr.splice(arr.indexOf(rem), 1)
    }

    return arr
}

/** Omit all given properties from the object */
export function omit(obj, ...props: string[]): object {
    let clone = { ...obj } as any
    props.forEach(p => delete clone[p])
    return clone
}

/** Merge the given object and the given list of object' properties */
export function merge(obj, ...otherObjs: object[]): object {
    let clone = { ...obj } as any
    otherObjs.forEach(o => Object.entries(o).forEach(e => clone[e[0]] = [1]))
    return clone
}