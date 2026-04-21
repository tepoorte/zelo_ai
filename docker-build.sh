#!/bin/bash
# Nead JQ : apt install jq bc

# Load variables .env
. ./.env

# Tag & Build for prod
echo "$DOCKERUSERNAME:$DOCKERPASSWORD@$DOCKERREGISTRY/v2/$IMAGENAME/tags/list"
CURVERSION=$(curl -sX GET https://$DOCKERUSERNAME:$DOCKERPASSWORD@$DOCKERREGISTRY/v2/$IMAGENAME/tags/list | jq -r '.tags[-2]')
NEWVERSION=$(echo "($CURVERSION + 0.1)" | bc)
echo "Last version : $CURVERSION / new version : $NEWVERSION"
read -p "Enter $IMAGENAME image version: " VERSION

DOCKERIMAGE=$DOCKERREGISTRY/$IMAGENAME
docker build --no-cache -t $DOCKERIMAGE .
docker tag $DOCKERIMAGE:latest $DOCKERIMAGE:$VERSION
# docker push $DOCKERIMAGE:$VERSION
# docker push $DOCKERIMAGE:latest
