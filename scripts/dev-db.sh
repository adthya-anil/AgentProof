#!/usr/bin/env bash
#
# Local PostgreSQL for development and tests.
#
# Creates the `agentproof` database so the persistence layer is exercised against
# a real server rather than mocked.
#
#   scripts/dev-db.sh up      initialise if needed, start, create database
#   scripts/dev-db.sh down    stop the server
#   scripts/dev-db.sh status  report readiness
#   scripts/dev-db.sh reset   drop and recreate the database
#   scripts/dev-db.sh url     print a DATABASE_URL that reaches this server
#
# Connects over a Unix socket rather than TCP. Some sandboxed environments reject
# loopback TCP (EHOSTUNREACH) even though the server is listening, and the socket
# path works everywhere. `scripts/dev-db.sh url` emits a URL with the socket host
# encoded, which node-postgres understands.
set -euo pipefail

PGDATA=${PGDATA:-/var/lib/pgsql/agentproof-data}
PORT=${AGENTPROOF_DB_PORT:-5432}
DB=${AGENTPROOF_DB_NAME:-agentproof}
PASSWORD=password

as_pg() { su postgres -c "$1"; }
psql_sock() { as_pg "psql -h '${PGDATA}' -p ${PORT} $1"; }

db_url() {
  echo "postgres://postgres:${PASSWORD}@/${DB}?host=${PGDATA}"
}

server_up() {
  as_pg "psql -h '${PGDATA}' -p ${PORT} -d postgres -tAc 'select 1'" >/dev/null 2>&1
}

start_server() {
  chown -R postgres:postgres "$(dirname "$PGDATA")" 2>/dev/null || true
  as_pg "pg_ctl -D '${PGDATA}' -l '${PGDATA}/server.log' -w start" >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    server_up && return 0
    sleep 1
  done
  return 1
}

init_cluster() {
  mkdir -p "$(dirname "$PGDATA")"
  rm -rf "$PGDATA"
  mkdir -p "$PGDATA"
  chown -R postgres:postgres "$(dirname "$PGDATA")"
  as_pg "initdb -D '${PGDATA}' -A trust --encoding=UTF8" >/dev/null
  {
    echo "listen_addresses = '127.0.0.1'"
    echo "port = ${PORT}"
    # Inside PGDATA: the packaged default (/var/run/postgresql) and /tmp are not
    # both writable in every environment, but PGDATA always is.
    echo "unix_socket_directories = '${PGDATA}'"
  } >> "${PGDATA}/postgresql.conf"
}

case "${1:-up}" in
  up)
    [ -s "${PGDATA}/PG_VERSION" ] || init_cluster
    # A socket file left behind by a killed server makes clients report
    # "connection refused"; clear it before starting.
    rm -f "${PGDATA}"/.s.PGSQL.* 2>/dev/null || true

    if ! start_server; then
      echo "postgres did not start; see ${PGDATA}/log/" >&2
      tail -20 "${PGDATA}"/log/*.log 2>/dev/null >&2 || true
      exit 1
    fi

    psql_sock "-d postgres -tAc \"alter role postgres with password '${PASSWORD}'\"" >/dev/null
    if ! psql_sock "-d postgres -tAc \"select 1 from pg_database where datname='${DB}'\"" | grep -q 1; then
      as_pg "createdb -h '${PGDATA}' -p ${PORT} -O postgres ${DB}" >/dev/null
    fi

    echo "postgres ready, database ${DB}"
    echo "DATABASE_URL=$(db_url)"
    ;;
  down)
    as_pg "pg_ctl -D '${PGDATA}' -m fast stop" >/dev/null 2>&1 || true
    echo stopped
    ;;
  status)
    if server_up; then echo ready; else echo "not ready"; exit 1; fi
    ;;
  reset)
    server_up || start_server
    psql_sock "-d postgres -tAc 'drop database if exists ${DB}'" >/dev/null
    as_pg "createdb -h '${PGDATA}' -p ${PORT} -O postgres ${DB}" >/dev/null
    echo "recreated ${DB}"
    ;;
  url)
    db_url
    ;;
  *)
    echo "usage: $0 {up|down|status|reset|url}" >&2
    exit 2
    ;;
esac
