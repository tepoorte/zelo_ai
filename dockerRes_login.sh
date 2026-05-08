#!/bin/sh
# Avvio dello script

#-------------------------------------------------------------------------
#docker compose --env-file .env -f docker-compose-dev.yml restart zelo_ai 
docker compose --env-file .env -f docker-compose-dev.yml up -d --build
#-------------------------------------------------------------------------


#curl -sS -X POST http://localhost:3041/ai/login \-H "content-type: application/json" \-d '{"userRef":"local-dev","username":"public-contact-003@example.invalid","password":"dummy_public_test_password"}'

#APIKEY="PUBLICDEMO01"
#SHOPID="000000000000000000000001"

#curl -sS "http://localhost:3040/shop/${SHOPID}/product/63f628443d8e320fc9334228/option?apiKey=${APIKEY}" | head -n 120