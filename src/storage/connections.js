/**
 * Database connections per thread. The main thread answers every RPC and keeps
 * eight; a match worker writes only its own players' accounts and keeps four,
 * so sixteen workers and the main thread stay under the common limit of a
 * hundred. Apart from storage/postgres.js so the count can be read without
 * loading the driver.
 */
export const MAIN_THREAD_CONNECTIONS = 8;
export const WORKER_THREAD_CONNECTIONS = 4;
