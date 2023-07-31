import { Connection, ConnectionOptions, RowDataPacket, createConnection } from "mysql";
import { Acknowledgable, Database, DatabaseProvider, DeleteResult, Table, UpdateOptions, UpdateResult } from "../db-service";
import { merge } from "../../util/types";

export type ProviderConnectOptions = Omit<ConnectionOptions, 'database'>

/** Connects to MySQL databases */
export class MySQLDatabaseProvider extends DatabaseProvider<Promise<MySQLDatabase>> {
    options: ConnectionOptions          // The options except the database
    dbCache: Map<string, MySQLDatabase> // The cached database instances

    db(name: string): Promise<MySQLDatabase> {
        if (this.dbCache.has(name))
            return Promise.resolve(this.dbCache.get(name))
        return new Promise((res, rej) => {
            let conn = createConnection(merge(this.options, { database: name }))
            conn.connect(err => {
                if (err) rej(err)
                else res(new MySQLDatabase(conn))
            })
        }).then(v => {
            this.dbCache.set(name, v as MySQLDatabase)
            return v as MySQLDatabase
        })
    }

    connect(): Promise<this> {
        // The connections arent made to the whole MySQL instance
        // but rather to each database. This means no connecting is required
        // right now.
        return Promise.resolve(this)
    }
}

/** Represents a MySQL database connection */
export class MySQLDatabase extends Database<RowDataPacket> {
    connection: Connection // The MySQL connection

    constructor(connection: Connection) {
        super()
        this.connection = connection
    }

    table(name: string): Table<RowDataPacket> {
        return new MySQLTable(this.connection, name)
    }
}

/** Represents a MySQL table */
export class MySQLTable extends Table<RowDataPacket> {
    _conn: Connection // The MySQL database connection
    _name: string     // The name of this SQL table

    constructor(conn: Connection, name: string) {
        super()
        this._conn = conn
        this._name = name
    }

    name(): string {
        return this._name
    }

    orCreate(): Promise<Table<RowDataPacket>> {
        return undefined // TODO
    }

    insert(object: RowDataPacket): Promise<Acknowledgable> {
        return undefined // TODO
    }

    update(filter: any, object: RowDataPacket, options: UpdateOptions): Promise<UpdateResult> {
        return undefined // TODO
    }

    delete(query: any): Promise<DeleteResult> {
        return undefined // TODO
    }

    defaultSchemaFor(proto: object, factory: () => any) {
        
    }

    findOne(query: any): Promise<RowDataPacket> {
        return undefined // TODO
    }
}