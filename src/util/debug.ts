let uidCt = 0;
export function getid(o){
    if (o.__uid) {
        return o.__uid;
    }

    o["__uid"] = ++uidCt
    return o.__uid;
};