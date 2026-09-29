'use strict';
// pet-kit public entry. Games import ONLY from here (the build checks it).
const Room=require('./room.js'),Wire=require('./wire.js');
module.exports={VERSION:Room.VERSION,Room,Wire};
