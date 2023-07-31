import { DatabaseProvider, Database, Table, DeleteResult, Acknowledgable, UpdateOptions, UpdateResult, bsonDocumentDirectMap } from '../db-service'
import { MongoClient, Collection, Filter, Db } from 'mongodb'
import { Document } from "bson";

/* ----------------- MongoDB Implementation ----------------- */
export class MongoDatabaseProvider extends DatabaseProvider<MongoDatabase> {
    public static with(connectionStr: string): DatabaseProvider<MongoDatabase> {
        let provider = new MongoDatabaseProvider()
        provider.connectionString = connectionStr
        provider.client = new MongoClient(connectionStr)
        return provider
    }

    connectionString: string                        // The connection string
    client: MongoClient                             // The MongoDB client if connected
    dbCache: Map<string, MongoDatabase> = new Map() // The cache of database instances

    async connect(): Promise<this> {
        return this.client.connect().then(_ => this)
    }

    db(name: string): MongoDatabase {
        let db: MongoDatabase
        if (db = this.dbCache.get(name)) {
            return db
        }

        this.dbCache.set(name, db = new MongoDatabase(this, this.client.db(name)))
        return db
    }
}

export class MongoDatabase extends Database<Document> {
    provider: MongoDatabaseProvider                 // The database provider
    database: Db                                    // The MongoDB database instance
    tableCache: Map<string, MongoTable> = new Map() // The cached table instances

    constructor(provider: MongoDatabaseProvider, database: Db) {
        super()
        this.provider = provider
        this.database = database
    }

    /** Get a table by name */
    public table(name: string): Table<Document> {
        let table: MongoTable
        if (table = this.tableCache.get(name)) {
            return table
        }

        this.tableCache.set(name, table = new MongoTable(name, this))
        return table
    }
}

export class MongoTable extends Table<Document> {
    constructor(name: string, db: MongoDatabase) {
        super()
        this.tName = name
        this.db = db

        this.collection = db.database.collection(this.tName)
    }

    tName: string                    // The name of this collection
    db: MongoDatabase                // The MongoDB database
    collection: Collection<Document> // The internal MongoDB collection

    // build the mongo filter from the given filter
    private buildMongoFilter(filter: any): Filter<Document> {
        // todo
        return filter
    }

    name(): string {
        return this.tName
    }

    orCreate(): Promise<Table<Document>> {
        return new Promise((resolve, reject) => {
            if (this.collection) {
                resolve(this)
                return
            }

            if (this.collection = this.db.database.collection(this.name())) {
                resolve(this)
                return
            }

            this.db.database.createCollection(this.name()).then(v => {
                this.collection = v
                resolve(this)
            })
        })
    }

    insert(object: Document): Promise<Acknowledgable> {
        return this.collection.insertOne(object).then<Acknowledgable>(v => ({ acknowleged: v.acknowledged }))
    }

    update(filter: any, object: Document, options: UpdateOptions): Promise<UpdateResult> {
        return this.collection.updateOne(this.buildMongoFilter(filter), { "$set" : object }, { upsert: options.upsert })
            .then(v => ({ acknowleged: v.acknowledged, modified: v.modifiedCount, matched: v.matchedCount, upserted: v.upsertedCount }))
    }

    delete(filter: any): Promise<DeleteResult> {
        return this.collection.deleteMany(this.buildMongoFilter(filter)).then(r => ({ acknowleged: r.acknowledged, deleted: r.deletedCount }))
    }

    findOne(query: any): Promise<Document> {
        return this.collection.findOne(this.buildMongoFilter(query))
    }

    defaultSchemaFor(proto: object, factory: () => any) {
        return bsonDocumentDirectMap(proto, factory)
    }
}