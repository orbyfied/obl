import { BotService, ServiceManager, autoRegister, eventHandler } from "../services";
import { Logger } from "../util/logging";
import { Optional } from "../util/optional";
import { AsyncQueue, QueuedOperation, qp } from "../util/functional";
import { EventEmitter } from "events";
import { Document } from 'bson'

// The logger instance
let logger: Logger

@autoRegister()
export class DatabaseService extends BotService {
    onLoad(manager: ServiceManager): void {
        logger = this.logger
    }

    @eventHandler('saveData')
    onSaveData() {
        dbOperationQueue.executeAll()
    }
}

/* --------------- Objects --------------- */

/** Represents a schema for type T */
export abstract class Schema<T> {
    abstract primaryKeyField(): string
}

/** Represents a schema mapping TSrc to T */
export abstract class MappingSchema<TSrc, T> extends Schema<T> {
    abstract fromSrc(src: TSrc): T 
    abstract toSrc(val: T): TSrc
}

/** Represents a schema dynamically mapping TSrc to T */
export abstract class DynamicMappingSchema<TSrc, T> extends MappingSchema<TSrc, T> {
    
}

/** Represents a schema which must always conform to a specific structure */
export abstract class StaticSchema<T> extends MappingSchema<object, T> {

}

/** Annotates the given property to be serialized */
export function serialize() {
    return function(target: object, propertyKey: string) {
        let list: any[] = target["___serialize_properties"]
        if (!list) list = target["___serialize_properties"] = []

        list.push({
            key: propertyKey
        })
    }
}

/** Annotates the given property as the primary key */
export function primaryKey() {
    return function(target: object, propertyKey: string) {
        target["___primary_key_property"] = {
            key: propertyKey
        }
    }
}

/** Create a document direct mapping */
export function bsonDocumentDirectMap<T>(proto: object, factory: () => T): DynamicMappingSchema<Document, T> {
    // calculate properties
    let properties: any[] = proto["___serialize_properties"]
    if (!properties)
        return null

    // calculate primary key name
    let primaryKey = proto["___primary_key_property"]
    if (!primaryKey)
        return null  
    let primaryKeyProperty: string = primaryKey.key
    
    // create mapping schema
    return new class extends DynamicMappingSchema<Document, T> {
        primaryKeyField(): string {
            return primaryKeyProperty
        }

        fromSrc(src: Document): T {
            if (!src)
                return undefined

            let data = factory()
            data[primaryKeyProperty] = src[primaryKeyProperty]
            properties.forEach(p => data[p.key] = src[p.key])

            return data
        }

        toSrc(val: T): Document {
            let doc: Document = { }
            doc[primaryKeyProperty] = val[primaryKeyProperty]
            properties.forEach(p => doc[p.key] = val[p.key])
            
            return doc
        }
    }
}

/** Represents a table/collection in a database */
export abstract class Table<T> {

    /** Get the name of this table reference */
    abstract name(): string

    /** Create this table if it does not exist yet */
    abstract orCreate(): Promise<Table<T>>

    /** Insert the given object */
    abstract insert(object: T): Promise<Acknowledgable>

    /** Update the given object */
    abstract update(filter: any, object: T, options: UpdateOptions): Promise<UpdateResult>

    /** Remove all objects matching the query */
    abstract delete(query: any): Promise<DeleteResult>

    /** Find one object by the given query */
    abstract findOne(query: any): Promise<T>

    /** Create a default schema for the given prototype */
    abstract defaultSchemaFor(proto: object, factory: () => any)

    /** Get the current schema of this table */
    public schema(): Schema<T> {
        return null
    }

    /** Create a new mapped table with the given schema */
    public mapped<T1>(schema: MappingSchema<T, T1>): Table<T1> {
        return new MappingSchemaTable(this, schema)
    }

    /** Create a new mapped table with the default schema for the
     *  given prototype. */
    public mappedFor<T1>(proto: object, factory: () => T1): Table<T1> {
        return this.mapped<T1>(this.defaultSchemaFor(proto, factory))
    }

    /** Create a datastore for this table */
    public datastore<K>(primaryKeyFieldName: string = null): Datastore<K, T> {
        return new Datastore(
            primaryKeyFieldName == null ? this.schema().primaryKeyField() : primaryKeyFieldName, 
            this
        )
    }

}

// Internal: Mapping schema based table
// delegating to another table
class MappingSchemaTable<TSrc, T> extends Table<T> {
    _base: Table<TSrc>              // The source table
    _schema: DynamicMappingSchema<TSrc, T> // The schema

    constructor(base: Table<TSrc>, schema: DynamicMappingSchema<TSrc, T>) {
        super()
        this._base = base
        this._schema = schema
    }

    public schema(): Schema<T> {
        return this._schema
    }

    name(): string {
        return this._base.name()
    }

    orCreate(): Promise<Table<T>> {
        return this._base.orCreate().then(_ => this)
    }

    insert(object: T): Promise<Acknowledgable> {
        return this._base.insert(this._schema.toSrc(object))
    }

    update(filter: any, object: T, options: UpdateOptions): Promise<UpdateResult> {
        return this._base.update(filter, this._schema.toSrc(object), options)
    }

    delete(query: any): Promise<DeleteResult> {
        return this._base.delete(query)
    }

    findOne(query: any): Promise<T> {
        return this._base.findOne(query).then(src => this._schema.fromSrc(src))
    }

    defaultSchemaFor(proto: object, factory: () => any) {
        return this._base.defaultSchemaFor(proto, factory)
    }
}

/** Represents a database connection */
export abstract class Database<TDefaultDoc> {
    /** Get a table reference by name */
    abstract table(name: string): Table<TDefaultDoc>
}

/** Represents a connection to a database list/provider */
export abstract class DatabaseProvider<TDb extends Promise<Database<any>> | Database<any>> {

    /** Connect the database provider */
    abstract connect(): Promise<this>

    /** Get or create a database with the given name */
    abstract db(name: string): TDb

}

// The queue of operations to execute
let dbOperationQueue: AsyncQueue = new AsyncQueue()
dbOperationQueue.runInterval(5 * 1000)

/** A tracked data object */
export class Tracked<K, T> {
    constructor(datastore: Datastore<K, T>, data: T, key: K) {
        this.datastore = datastore
        this.value = data
        this.key = key
    }

    key: K                       // The data key
    datastore: Datastore<any, T> // The datastore
    value: T                     // The data value
    eventEmitter: EventEmitter   // The event dispatcher

    /** Get the event emitter for this tracked object */
    public get events(): EventEmitter {
        if (!this.eventEmitter) {
            this.eventEmitter = new EventEmitter()
        }

        return this.eventEmitter
    }

    /** Get the data as an optional */
    public get data(): Optional<T> {
        return Optional.define(this.value)
    }

    /** Run the given code if a value is present */
    public ifPresent(func: (v: T) => void): this {
        if (this.value) {
            func(this.value)
        }

        return this
    }

    private onPush(): this {
        if (this.eventEmitter) {
            this.eventEmitter.emit('push', this)
        }

        if (this.value && this.value['onPush']) {
            this.value['onPush'](this)
        }

        return this
    }

    /** Push the current data to the db */
    public push(queue: boolean = true): Promise<this> {
        if (!this.value)
            return new Promise((_, reject) => reject('nodata'))
        return this.datastore.update(this, this.value, queue).then(_ => this.onPush())
    }

    private onFetch(): this {
        if (this.eventEmitter) {
            this.eventEmitter.emit('fetch', this)
        }

        if (this.value && this.value['onFetch']) {
            this.value['onFetch'](this)
        }

        return this
    }

    /** Pull new data from the db on demand */
    public fetch(queue: boolean = false): Promise<this> {
        return this.datastore.pull(this, queue).then(_ => this.onFetch())
    }

    /** Pull data from the db if no data is set yet */
    public orFetch(queue: boolean = false): Promise<this> {
        if (this.value) {
            return Promise.resolve(this) 
        }

        return this.fetch(queue)
    }

    /** Set a value if no value is defined yet */
    public orElseGet(defSupplier: (k: K) => T): this {
        if (!this.value) {
            this.value = defSupplier(this.key)
        }

        return this
    }

    /** Set a value if no value is defined yet */
    public orElse(def: T): this {
        if (!this.value) {
            this.value = def
        }

        return this
    }

    /** Delete this tracked object and it's data from the cache and db */
    public delete(): Promise<this> {
        return this.datastore.delete(this).then(_ => this)
    }

    /** Set the value on this tracked object */
    public set(v: T): this {
        this.value = v
        return this
    }

    /* ----- Queued Operations ----- */
    queuedFetch: QueuedOperation<Promise<this>> = new QueuedOperation()
    queuedPush: QueuedOperation<UpdateResult> = new QueuedOperation()
    queuedDelete: QueuedOperation<DeleteResult> = new QueuedOperation()
}

/** A further abstraction from database tables with caching of data */
export class Datastore<K, T> {
    constructor(primaryKeyField: string, table: Table<T>) {
        this.primaryKeyField = primaryKeyField
        this.table = table
    }

    primaryKeyField: string                    // The name of the primary key field
    table: Table<T>                            // The table to source data from
    cache: Map<any, Tracked<K, T>> = new Map() // The data cache, set to null to disable

    public getPrimaryKey(v: T): K {
        return v == undefined ? 0 : v[this.primaryKeyField]
    }

    /** Get an object by key, or get the default if supplied */
    public get(key: K): Tracked<K, T> {
        let item: Tracked<K, T>

        // check cache if enabled
        if (this.cache && (item = this.cache.get(key))) {
            return item
        }

        this.cache.set(key, item = new Tracked(this, undefined, key))
        return item
    }

    /** Find an object by key */
    public find(query: any, defSupplier: () => T = undefined, queue: boolean = false): Promise<Tracked<K, T>> {
        // check for primary key query
        let pk
        if (pk = query[this.primaryKeyField] != undefined) {
            return this.get(pk).fetch().then(t => t.orElseGet(defSupplier))
        }

        // find from table
        return dbOperationQueue.queueOptionally(qp().set(() => this.table.findOne(query).then(v => {
            if (!v) v = defSupplier()
            return this.get(this.getPrimaryKey(v)).set(v)
        })), queue).then(r => r)
    }

    /** Pull updated data for the given tracked object */
    public pull<Tr extends Tracked<K, T>>(tracked: Tr, queue: boolean = false): Promise<Tr> {
        return dbOperationQueue.queueOptionally(tracked.queuedFetch.set(() => this.table.findOne({ [this.primaryKeyField]: tracked.key }).then(v => {
            return tracked.set(v)
        })), queue).then(r => r)
    }

    /** Update or insert the exact given value */
    public update(tracked: Tracked<K, T>, val: T, queue: boolean = true): Promise<UpdateResult> {
        return dbOperationQueue.queueOptionally(tracked.queuedPush.set(() => 
            this.table.update({ [this.primaryKeyField]: val[this.primaryKeyField] }, val, { upsert: true })),
            queue).then(r => r)
    }

    /** Delete the exact given value */
    public delete(tracked: Tracked<K, T>, queue: boolean = true): Promise<DeleteResult> {
        // remove from cache
        if (this.cache) {
            this.cache.delete(tracked.key)
        }

        return dbOperationQueue.queueOptionally(tracked.queuedDelete.set(() => 
            this.table.delete({ [this.primaryKeyField]: tracked.key })),
            queue).then(r => r)
    }
}

/* ----------------- Action Types ----------------- */
export type UpdateOptions = { upsert: boolean }

export type Acknowledgable = { acknowleged: boolean,  }
export type UpdateResult = Acknowledgable & { modified: number, matched: number, upserted: number }
export type DeleteResult = Acknowledgable & { deleted: number }