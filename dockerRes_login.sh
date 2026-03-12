#!/bin/sh
# Avvio dello script

docker compose -f docker-compose.zelo-ai.yml restart zelo_ai  
#curl -sS -X POST http://localhost:3041/ai/login \-H "content-type: application/json" \-d '{"userRef":"local-dev","username":"public-contact-003@example.invalid","password":"dummy_public_test_password"}'
