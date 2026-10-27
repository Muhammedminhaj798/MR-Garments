import { loadEnvFile } from "../config";

// Each worktree's .env points at that worktree's own database (W4). Tests always run with NODE_ENV=test.
loadEnvFile(".env.test"); // optional: a worktree whose .env serves manual testing keeps its test database here
loadEnvFile();
process.env.NODE_ENV = "test";
