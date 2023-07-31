/** Remove all elements provided by the given iterable from the array */
export function removeAll<T>(arr: Array<T>, toRemove: Iterable<T>): Array<T> {
    for (let rem of toRemove) {
        arr.splice(arr.indexOf(rem), 1)
    }

    return arr
}