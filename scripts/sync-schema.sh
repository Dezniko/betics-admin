#!/bin/sh
# The central database schema is owned by the game core repo (betics). Refresh the test copy.
cat ../betics/migrations/*.sql > test/schema.sql
