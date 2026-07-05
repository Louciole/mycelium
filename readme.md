# Mycelium.

❓️A rich and ethical communication software to build your digital home. <br>  
🌍 Production : https://mycelium.carbonlab.dev <br>
🟢 Status : https://status.carbonlab.dev <br>
🏀 Roadmap : https://synapse.carbonlab.dev/project?uid=6&access=read-only <br>
🏡 Home : https://gitlab.com/Louciole/disclone


## 🏎️ getting started

### install :


1. edit `server.ini` with your parameters


2. add the DKIM private key in `mailing/dkim.txt`

       nano mailing/dkim.txt

   or you can just copy your local file


3. create a venv


4. install dependencies

   `pip install -r requirements.txt`


5. run `vesta install` to import vesta's files


6. run `python server.py` to start the server

## Run

to run use 

0. (for windows only) `wsl`

1. `source venv/bin/activate`

2. `python server.py`


## 🖥️ Work
If you plan to commit something don't forget to IGNORE the *.ini file
run

	git update-index --assume-unchanged server.ini

## 🧶 Troubleshooting

if postgres does not accept password authentication, you can change the `pg_hba.conf` file

`sudo nano /etc/postgresql/16/main/pg_hba.conf`

replace peer by ident