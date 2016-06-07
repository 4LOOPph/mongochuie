requirements, install nodeJs

debian (as root):
apt-get install curl
curl -sL https://deb.nodesource.com/setup | bash -
apt-get install nodejs

ubuntu, linux mint, ecta
sudo apt-get install curl
curl -sL https://deb.nodesource.com/setup | sudo bash -
sudo apt-get install nodejs

For other distributions look here:
https://github.com/joyent/node/wiki/Installing-Node.js-via-package-manager

install mms as root:
sudo ./install.sh

start mms server from console with:
lx-mms

open mms in browser: http://127.0.0.1:3333

uninstall mms:
sudo rm /usr/local/bin/lx-mms
sudo rm -R /opt/lx-mms
