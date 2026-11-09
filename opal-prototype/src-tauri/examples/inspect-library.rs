use std::{env, error::Error, path::PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::json;

fn main() -> Result<(), Box<dyn Error>> {
    let database_path = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("Usage: inspect-library <database-path>")?;
    let connection = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let schema = connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
    let projects = connection.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get::<_, i64>(0))?;
    let tracks = connection.query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get::<_, i64>(0))?;

    println!("{}", json!({ "schema": schema, "projects": projects, "tracks": tracks }));
    Ok(())
}
