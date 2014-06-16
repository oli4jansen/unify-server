"use strict";

// Alle modules importeren
var config          = require("./config");

var _               = require("underscore");
var crypto          = require("crypto");
var emailjs         = require("emailjs/email");
var when            = require('when');
var nodefn          = require('when/node/function');

var mysql           = require("mysql");
var orm             = require("orm");

var restify         = require("restify");
var restifyOAuth2   = require("restify-oauth2");

// Restify server instellen
var server = restify.createServer({
    name: "Shui Server",
    version: require("./package.json").version
});

// Middleware

server.use(restify.authorizationParser());
server.use(restify.bodyParser({ mapParams: false }));

server.use(restify.fullResponse());

server.use(restify.CORS({ origins: ['*'] }));
restify.CORS.ALLOW_HEADERS.push('authorization');

var mailServer  = emailjs.server.connect({
    user:     config.smtp.user, 
    password: config.smtp.password, 
    host:     config.smtp.host, 
    ssl:      config.smtp.ssl
});

// Verbinden met MySQL database
orm.connect(config.dbPath, function (err, db) {
    if (err) console.log(err);

    db.load("./models", function (err) {

        if(err) console.log(err);

        var User         = db.models.users;
        var Token        = db.models.tokens;
        var Project      = db.models.projects;
        var Task         = db.models.tasks;
        var Message      = db.models.messages;
        var File         = db.models.files;
        var Notification = db.models.notifications;

        Project.hasMany('participants', User, { joined: Date, invited_by: String }, { reverse: 'projects' });

        Task.hasOne('project', Project, { reverse: 'tasks' });
        Message.hasOne('project', Project, { reverse: 'messages' });
        File.hasOne('project', Project, { reverse: 'files' });
      
        Notification.hasOne('receiver', User, { reverse: 'notifications' });

        db.sync();

        /*
            OAuth Hooks
        */

        var hooks = {};

        function generateToken(data) {
            var random = Math.floor(Math.random() * 100001);
            var timestamp = (new Date()).getTime();
            var sha256 = crypto.createHmac("sha256", random + "suchsalt" + timestamp);

            return sha256.update(data).digest("base64");
        }

        hooks.validateClient = function (credentials, req, cb) {
            // Call back with `true` to signal that the client is valid, and `false` otherwise.
            // Call back with an error if you encounter an internal server error situation while trying to validate.

            var isValid = _.has(config.clients, credentials.clientId) && config.clients[credentials.clientId].secret === credentials.clientSecret;
            cb(null, isValid);
        };

        // Functie die aangesproken wordt als de gebruiker geen access token heeft en inlogt met emailadress +
        hooks.grantUserToken = function (credentials, req, cb) {
            // Gebruiker met opgegeven emailadres opzoeken
            User.find({ email: credentials.username }, function(err, data) {

                if(err) console.log(err);

                // Als dit emailadres niks oplevert:
                if(data.length === 0) {
                    var timestamp = (new Date()).getTime();
                    // Generate verification code
                    var code = crypto.createHash('sha1').update(credentials.username+timestamp).digest("hex");

                    // Create new username
                    User.create([{
                        verification_code: code,
                        name: '',
                        email: credentials.username,
                        password: credentials.password
                    }], function(err, data){

                        if(err) console.log(err);

                        var message = {
                           text:    "Please navigate to "+config.clients.webClient.clientPath+"/verification/"+credentials.username+"/"+code, 
                           from:    "Olivier Jansen <oli4jansen.nl@gmail.com>", 
                           to:      credentials.username,
                           subject: "Shui - Confirm email address",
                           attachment: 
                           [
                              {data:"<html>Please navigate to <a href=\""+config.clients.webClient.clientPath+"/verification/"+credentials.username+"/"+code+"\">"+config.clients.webClient.clientPath+"/verification/"+credentials.username+"/"+code+"</a> to confirm your email address.</html>", alternative:true}
                           ]
                        };

                        mailServer.send(message, function(err, message) {
                            if(err) console.log(err);

                            // Token aanmaken
                            var token = generateToken(credentials.username + ":" + credentials.password);                       
                            // Token opslaan in database
                            Token.create([{
                                token: token,
                                email: credentials.username
                            }], function(err, data){
                                if(err) console.log(err);
                                // Token terugsturen naar client
                                return cb(null, token);
                            });
                        });
                    });
                } else if(data.length === 1) {
                    // Wachtwoord controleren
                    if(data[0].password === credentials.password) {
                        // Token aanmaken
                        var token = generateToken(credentials.username + ":" + credentials.password);
                        // Token opslaan in database
                        Token.create([{
                            token: token,
                            email: credentials.username
                        }], function(err, data){
                            // Token terugsturen naar client
                            return cb(null, token);
                        });

                    }else{
                        console.log(data[0].password + '!==' + credentials.password);
                        return cb(null, false);
                    }
                } else {
                    return cb(null, false);
                }
            });
        };

        hooks.authenticateToken = function (token, req, cb) {
            Token.find({ token: token }, function(err, data) {
                if(err) {
                    return cb(null, false);
                }else{
                    req.username = data[0].email;
                    return cb(null, true);
                }
            });
        };

        restifyOAuth2.ropc(server, { tokenEndpoint: '/token', hooks: hooks });

        /*
            API routes and response functions
        */

        var postNotification = function (receiver, project, sender_name, type) {

            if(typeof receiver !== 'object') {
                var receiver_email = receiver;
            }else{
                var receiver_email = receiver.email;
            }

            Notification.create({
                sender_name: sender_name,
                receiver_email: receiver_email,
                type: type,
                project_id: project.id,
                project_name: project.name,
                unread: 1
            }, function (err, item) {
                if(err) {
                    console.log(err);
                }else{
                    if(typeof receiver === 'object') {
                        if(receiver.email_notifications) {
                            // send email to receiver
                        }
                        if(receiver.mobile_notifications) {
                            // send mobile notification
                        }
                    }else{
                        User.get(receiver, function (err, receiver) {
                            if(receiver && !err) {
                                if(receiver.email_notifications) {
                                    // send email to receiver
                                }
                                if(receiver.mobile_notifications) {
                                    // send mobile notification
                                }
                            }else{
                                console.log(err);
                            }
                        });
                    }
                }
            });

        };

    // Get user details
        server.get('/me', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/me');
            res.contentType = "application/json";

            User.get(req.username, function (err, me) {

                if(err) console.log(err);

                if(me) {

                    me.getNotifications(function (err, notifications) {
                        me.unreadNotifications = 0;
                        if(err) {
                            console.log(err);
                        }else{
                            notifications.forEach(function (notification) {
                                if(notification.unread) me.unreadNotifications++;
                            });
                        }
                        if(me.verification_code == '') {
                            var verified = true;
                        }else{
                            var verified = false;
                        }

                        res.send({
                            verified: verified,
                            name: me.name,
                            email: me.email,
                            emailNotifications: me.email_notifications,
                            mobileNotifications: me.mobile_notifications,
                            unreadNotifications: me.unreadNotifications
                        });
                    });

                }else{
                    res.status(404);
                    res.send({})
                }
            });
        });

    // Update user details
        server.post('/me', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/me [POST]');
            res.contentType = "application/json";

            if(req.body.name !== undefined && req.body.name !== '') {
                User.get(req.username, function (err, me) {

                    me.name = req.body.name;
                    me.save(function (err) {
                        if(err) {
                            console.log(err);
                            res.status(500);
                            res.send({ msg: 'Something went wrong while updating your settings.' });
                        }else{
                            res.send({
                                name: me.name,
                                email: me.email,
                                emailNotifications: me.email_notifications,
                                mobileNotifications: me.mobile_notifications
                            });
                        }
                    });
                });
            }else{
                res.status(500);
                res.send({ msg: 'You didnt provide any information to update.' });
            }
        });

    // Get user notifications
        server.get('/me/notifications', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/me/notifications');
            res.contentType = "application/json";

            User.get(req.username, function (err, me) {

                if(err) console.log(err);

                if(me) {

                    me.getNotifications(function (err, notifications) {
                        if(err) console.log(err);
                        if(notifications && notifications.length > 0) {
                            res.send(notifications);
                        }else{
                            console.log('Geen notifications:');
                            console.log(notifications);
                            res.send([]);
                        }
                    });

                }else{
                    res.status(404);
                    res.send({})
                }
            });
        });

    // Read user notifications
        server.post('/me/notifications', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/me/notifications [POST]');
            res.contentType = "application/json";

            User.get(req.username, function (err, me) {

                if(err) console.log(err);

                if(me) {

                    me.getNotifications(function (err, notifications) {
                        if(err) console.log(err);
                        if(notifications) {

                            for(var i=0;i<notifications.length;i++) {
                                if(notifications[i].unread) notifications[i].unread = 0;
                                notifications[i].save(function (err) {
                                    if(err) console.log(err);
                                });
                            }
                            res.send({});
                        }else{
                            res.send({});
                        }
                    });

                }else{
                    res.status(404);
                    res.send({})
                }
            });
        });

    // Check email address verification code
        server.post('/verify', function (req, res) {
            console.log('/verify');
            res.contentType = "application/json";

            if(req.body.email !== undefined && req.body.code !== '') {
                User.get(req.body.email, function (err, me) {

                    if(!err && req.body.code === me.verification_code) {
                        me.verification_code = '';
                        me.save(function (err) {
                            if(err) {
                                console.log(err);
                                res.status(500);
                                res.send({ msg: 'Your code matched but we couldnt update our database.' });
                            }else{
                                res.send({});
                            }
                        });
                    }else if(me.verification_code == '') {
                        res.status(200);
                        res.send({ msg: 'Account is already verified.' });
                    }else{
                        res.status(401);
                        res.send({ msg: 'Your code didnt match ours.' });                        
                    }
                });
            }
        });

    // Get all projects
        server.get('/projects', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/projects');
            res.contentType = "application/json";

            User.get(req.username, function (err, me) {
                me.getProjects(function (err, projects) {

                    if(projects && projects.length > 0) {
                        var counter = projects.length;

                        projects.forEach(function (project) {

                            var index = projects.indexOf(project);

                            project.openTasks = 0;
                            project.myTasks = 0;
                            project.participants = [];

                            project.getTasks(function (err, tasks) {
                                if(err) console.log(err);

                                if(tasks) {
                                    tasks.forEach(function (task) {
                                        if(!task.finished) project.openTasks++;
                                        if(!task.finished && task.assignedTo == req.username) project.myTasks++;
                                    });
                                }

                                project.getParticipants(function (err, participants) {
                                    if(err) console.log(err);

                                    participants.forEach(function (participant) {
                                        project.participants.push({ name: participant.name, email: participant.email });
                                    });

                                    counter--;
                                    if(counter==0) res.send(projects);
                                });
                            });
                        });
                    }else{
                        res.send([]);
                    }
                });
            });
        });

    // Create a project
       server.post('/projects', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/projects [POST]');
            res.contentType = "application/json";

            User.get(req.username, function (err, me) {
                if(me) {
                    if(req.body.name && req.body.participants) {

                        Project.create({
                            name: req.body.name
                        }, function (err, project) {
                            if(err) {
                                console.log(err);
                                res.status(500);
                                res.send({ msg: err });
                            }else{
                                project.addParticipants(me, function(err){
                                    if(!err) {
                                        req.body.participants.forEach(function (participant) {
                                            if(participant.email !== req.username) {
                                                User.get(participant.email, function (err, person) {
                                                    if(err) console.log(err);
                                                    if(person) {
                                                        project.addParticipants(person, { invited_by: req.username }, function(err){
                                                            if(err) console.log(err);
                                                            postNotification(person.email, project, me.name, 'invite');
                                                        });
                                                    }else{
                                                        console.log(person);
                                                    }
                                                });
                                            }else{
                                                console.log('Niet toegevoegd want is oprichter.');
                                            }
                                        });
                                        res.send(project);
                                    }else{
                                        console.log(err);
                                        project.remove();
                                        res.status(500);
                                        res.send({ msg: err });
                                    }
                                });
                            }
                        });

                    }else{
                        res.status(500);
                        res.send({ msg: 'Please provide complete data.' });
                    }
                }else{
                    res.status(403);
                    res.send({ msg: 'Unauthorized.' });
                }
            });
        });

    // Get project details
        server.get('/projects/:id', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/projects/:id');
            res.contentType = "application/json";

            Project.get(req.params.id, function (err, project) {
                project.getParticipants(function (err, participants) {
                    User.get(req.username, function (err, me) {
                        project.hasParticipants(me, function (err, bool) {
                            if(bool) {
                                project.getTasks(function (err, tasks) {
                                    var response = project;

                                    response.myTasks = 0;

                                    if(tasks) {
                                        tasks.forEach(function (task) {
                                            if(!task.finished && task.assignedTo == req.username) response.myTasks++;
                                        });
                                    }

                                    response.participants = [];
                                    participants.forEach(function(participant) {
                                        response.participants.push({
                                            name: participant.name,
                                            email: participant.email,
                                            invited_by: participant.invited_by
                                        });
                                    });
                                    response.tasks = (tasks) ? tasks.length : 0;

                                    res.send(response);
                                });
                            }else{
                                res.status(404);
                                res.send({ msg: 'User does not have a project with that ID.' });
                            }
                        });
                    });
                });
            });
        });

    // Invite someone
        server.put('/projects/:id/participants', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/projects/:id/participants [PUT]');
            res.contentType = "application/json";

            Project.get(req.params.id, function (err, project) {
                project.getParticipants(function (err, participants) {
                    User.get(req.username, function (err, me) {
                        project.hasParticipants(me, function (err, bool) {
                            if(bool) {
                                project.getParticipants(function (err, participants) {
                                    var isPersonAlreadyParticipant = false;
                                    participants.forEach(function(participant) {
                                        if(participant.email == req.body.email) isPersonAlreadyParticipant = true;
                                    });

                                    if(!isPersonAlreadyParticipant) {

                                        User.get(req.body.email, function (err, person) {
                                            if(err) console.log(err);
                                            if(!person) {
                                                res.status(404);
                                                res.send({ msg: 'This person isnt registered for Shui yet.' });
                                            }else{
                                                project.addParticipants(person, { invited_by: req.username }, function(err){
                                                    if(!err) {
                                                        res.send({
                                                            name: person.name,
                                                            email: person.email,
                                                            invited_by: req.username
                                                        });

                                                        postNotification(person.email, project, me.name, 'invite');

                                                    }else{
                                                        res.status(500);
                                                        res.send({ msg: err });
                                                    }
                                                });
                                            }
                                        });

                                    }else{
                                        res.status(409);
                                        res.send({ msg: 'This person is already a participant.' });
                                    }
                                });
                            }else{
                                res.status(404);
                                res.send({ msg: 'User does not have a project with that ID.' });
                            }
                        });
                    });
                });
            });
        });

    // Delete a participant
        server.del('/projects/:id/participants/:participantId', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/projects/:id/participants/:participantId [DELETE]');
            res.contentType = "application/json";

            Project.get(req.params.id, function (err, project) {
                if(err) console.log(err);
                project.getParticipants(function (err, participants) {
                    if(err) console.log(err);
                    var participantCount = participants.length;
                    User.get(req.username, function (err, me) {
                     if(err) console.log(err);
                       project.hasParticipants(me, function (err, bool) {
                            if(err) console.log(err);
                            if(bool) {
                                var participant = false;
                                participants.forEach(function (item) {
                                    if(item.email == req.params.participantId) participant = item;
                                });

                                if(participant) {
                                    if(participant.email == req.username || participant.invited_by == req.username) {
                                        project.removeParticipants(participant, function (err) {
                                            if(err) {
                                                console.log(err);
                                                res.status(500);
                                                res.send({ msg: err });
                                            }else{
                                                res.send({});
                                                if(participantCount === 1) {
                                                    project.removeMessages(function (err) {
                                                        if(err) console.log(err);
                                                        project.removeTasks(function (err) {
                                                            if(err) console.log(err);
                                                            project.removeFiles(function (err) {
                                                                if(err) console.log(err);
                                                                project.remove(function (err) {
                                                                    if(err) console.log(err);
                                                                });
                                                            });
                                                        });
                                                    });
                                                }
                                            }
                                        });
                                    }else{
                                        res.status(403);
                                        res.send({ msg: 'The user is not authorized to delete this participant.' });                                                    
                                    }
                                }else{
                                    console.log(err);
                                    res.status(404);
                                    res.send({ msg: 'The user to delete was no participant.' });
                                }
                            }else{
                                res.status(404);
                                res.send({ msg: 'User does not have a project with that ID.' });
                            }
                        });
                    });
                });
            });
        });

    // Get all tasks
       server.get('/projects/:id/tasks', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/projects/:id/tasks');
            res.contentType = "application/json";

            Project.get(req.params.id, function (err, project) {
                project.getParticipants(function (err, participants) {
                    User.get(req.username, function (err, me) {
                        project.hasParticipants(me, function (err, bool) {
                            if(bool) {
                                project.getTasks(function (err, tasks) {
                                    if(err) console.log(err);
                                    if(tasks) {
                                        res.send(tasks);
                                    }else{
                                        res.send([]);
                                    }
                                });
                            }else{
                                res.status(404);
                                res.send({ msg: 'User does not have a project with that ID.' });
                            }
                        });
                    });
                });
            });
        });

    // Create a task
       server.post('/projects/:id/tasks', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/projects/:id/tasks [POST]');
            res.contentType = "application/json";

            Project.get(req.params.id, function (err, project) {
                project.getParticipants(function (err, participants) {
                    User.get(req.username, function (err, me) {
                        project.hasParticipants(me, function (err, bool) {
                            if(bool) {

                                Task.create({
                                    project_id  : req.params.id,
                                    name        : req.body.name,
                                    description : req.body.description,
                                    assignedBy  : req.username,
                                    assignedTo  : req.body.assignedTo,
                                    finished    : false,
                                    hours       : 0
                                }, function (err, item) {
                                    if(err) {
                                        console.log(err);
                                        res.status(500);
                                        res.send({ msg: err });
                                    }else{
                                        res.send(item);

                                        // Trigger notification HERE (to person task is assigned to)
                                    }
                                });
                            }else{
                                res.status(404);
                                res.send({ msg: 'User does not have a project with that ID.' });
                            }
                        });
                    });
                });
            });
        });

    // Delete a task
        server.del('/projects/:id/tasks/:taskId', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/projects/:id/tasks/:taskId [DELETE]');
            res.contentType = "application/json";

            Project.get(req.params.id, function (err, project) {
                project.getParticipants(function (err, participants) {
                    User.get(req.username, function (err, me) {
                        project.hasParticipants(me, function (err, bool) {
                            if(bool) {
                                Task.get(req.params.taskId, function (err, task) {
                                    if(task.assignedBy == req.username) {
                                        task.remove(function (err) {
                                            if(err) {
                                                console.log(err);
                                                res.status(500);
                                                res.send({ msg: err });
                                            }else{
                                                res.send({});
                                            }
                                        });
                                    }else{
                                        res.status(401);
                                        res.send({ msg: 'Unauthorized, this task wasnt created by you.' });
                                    }
                                });
                            }else{
                                res.status(404);
                                res.send({ msg: 'User does not have a project with that ID.' });
                            }
                        });
                    });
                });
            });
        });

    // Finish a task
        server.post('/projects/:id/tasks/:taskId', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/projects/:id/tasks/:taskId [POST]');
            res.contentType = "application/json";

            Project.get(req.params.id, function (err, project) {
                project.getParticipants(function (err, participants) {
                    User.get(req.username, function (err, me) {
                        project.hasParticipants(me, function (err, bool) {
                            if(bool) {
                                Task.get(req.params.taskId, function (err, task) {
                                    if(task.assignedTo == req.username) {
                                        task.hours = parseFloat(req.body.hours);
                                        task.finished = true;
                                        task.evaluation = req.body.evaluation;

                                        task.save(function (err) {
                                            if(err) {
                                                console.log(err);
                                                res.status(500);
                                                res.send({ msg: err });
                                            }else{
                                                res.send({});

                                                // Trigger notification HERE (to person that assigned task)

                                            }
                                        });
                                    }else{
                                        res.status(401);
                                        res.send({ msg: 'Unauthorized, this task wasnt assigned to you.' });
                                    }
                                });
                            }else{
                                res.status(404);
                                res.send({ msg: 'User does not have a project with that ID.' });
                            }
                        });
                    });
                });
            });
        });

    // Get all messages
       server.get('/projects/:id/messages', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/projects/:id/messages');
            res.contentType = "application/json";

            Project.get(req.params.id, function (err, project) {
                project.getParticipants(function (err, participants) {
                    User.get(req.username, function (err, me) {
                        project.hasParticipants(me, function (err, bool) {
                            if(bool) {
                                project.getMessages([ "id", "Z"], function (err, messages) {
                                    if(err) console.log(err);
                                    if(messages) {
                                        res.send(messages);
                                    }else{
                                        res.send([]);
                                    }
                                });
                            }else{
                                res.status(404);
                                res.send({ msg: 'User does not have a project with that ID.' });
                            }
                        });
                    });
                });
            });
        });

    // Create a message
       server.post('/projects/:id/messages', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/projects/:id/messages [POST]');
            res.contentType = "application/json";

            Project.get(req.params.id, function (err, project) {
                project.getParticipants(function (err, participants) {
                    User.get(req.username, function (err, me) {
                        project.hasParticipants(me, function (err, bool) {
                            if(bool) {

                                var now = new Date();
                                var year = now.getFullYear();
                                var month = now.getMonth()+1;
                                var date = now.getDate();
                                var hours = now.getHours();
                                var minutes = now.getMinutes();
                                var seconds = now.getSeconds();

                                Message.create({
                                    body       : req.body.body,
                                    author     : req.username,
                                    project_id : req.params.id,
                                    created    :  year+'-'+month+'-'+date+' '+hours+':'+minutes+':'+seconds
                                }, function (err, item) {
                                    if(err) {
                                        console.log(err);
                                        res.status(500);
                                        res.send({ msg: err });
                                    }else{
                                        res.send(item);

                                        // Trigger notification HERE (to person task is assigned to)
                                    }
                                });
                            }else{
                                res.status(404);
                                res.send({ msg: 'User does not have a project with that ID.' });
                            }
                        });
                    });
                });
            });
        });

    // Delete a message
        server.del('/projects/:id/messages/:messageId', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/projects/:id/tasks/:taskId [DELETE]');
            res.contentType = "application/json";

            Project.get(req.params.id, function (err, project) {
                project.getParticipants(function (err, participants) {
                    User.get(req.username, function (err, me) {
                        project.hasParticipants(me, function (err, bool) {
                            if(bool) {
                                Message.get(req.params.messageId, function (err, message) {
                                    if(message.author == req.username) {
                                        message.remove(function (err) {
                                            if(err) {
                                                console.log(err);
                                                res.status(500);
                                                res.send({ msg: err });
                                            }else{
                                                res.send({});
                                            }
                                        });
                                    }else{
                                        res.status(401);
                                        res.send({ msg: 'Unauthorized, this messages wasnt written by you.' });
                                    }
                                });
                            }else{
                                res.status(404);
                                res.send({ msg: 'User does not have a project with that ID.' });
                            }
                        });
                    });
                });
            });
        });

    // Get all files
       server.get('/projects/:id/files', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/projects/:id/tasks');
            res.contentType = "application/json";

            Project.get(req.params.id, function (err, project) {
                project.getParticipants(function (err, participants) {
                    User.get(req.username, function (err, me) {
                        project.hasParticipants(me, function (err, bool) {
                            if(bool) {
                                project.getFiles(function (err, files) {
                                    if(err) console.log(err);
                                    if(files) {
                                        res.send(files);
                                    }else{
                                        res.send([]);
                                    }
                                });
                            }else{
                                res.status(404);
                                res.send({ msg: 'User does not have a project with that ID.' });
                            }
                        });
                    });
                });
            });
        });

    // Create a file
       server.post('/projects/:id/files', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/projects/:id/files [POST]');
            res.contentType = "application/json";

            Project.get(req.params.id, function (err, project) {
                project.getParticipants(function (err, participants) {
                    User.get(req.username, function (err, me) {
                        project.hasParticipants(me, function (err, bool) {
                            if(bool) {

                                var now = new Date();
                                var year = now.getFullYear();
                                var month = now.getMonth()+1;
                                var date = now.getDate();
                                var hours = now.getHours();
                                var minutes = now.getMinutes();
                                var seconds = now.getSeconds();

                                File.create({
                                    name       : req.body.name,
                                    description: req.body.description,
                                    url        : req.body.url,
                                    author     : req.username,
                                    project_id : req.params.id,
                                    created    :  year+'-'+month+'-'+date+' '+hours+':'+minutes+':'+seconds
                                }, function (err, item) {
                                    if(err) {
                                        console.log(err);
                                        res.status(500);
                                        res.send({ msg: err });
                                    }else{
                                        res.send(item);

                                        // Trigger notification HERE
                                    }
                                });
                            }else{
                                res.status(404);
                                res.send({ msg: 'User does not have a project with that ID.' });
                            }
                        });
                    });
                });
            });
        });

    // Delete a file
        server.del('/projects/:id/files/:fileId', function (req, res) {
            if (!req.username) return res.sendUnauthenticated();
            console.log('/projects/:id/files/:fileId [DELETE]');
            res.contentType = "application/json";

            Project.get(req.params.id, function (err, project) {
                project.getParticipants(function (err, participants) {
                    User.get(req.username, function (err, me) {
                        project.hasParticipants(me, function (err, bool) {
                            if(bool) {
                                File.get(req.params.fileId, function (err, file) {
                                    if(file.author == req.username) {
                                        file.remove(function (err) {
                                            if(err) {
                                                console.log(err);
                                                res.status(500);
                                                res.send({ msg: err });
                                            }else{
                                                res.send({});
                                            }
                                        });
                                    }else{
                                        res.status(401);
                                        res.send({ msg: 'Unauthorized, this file wasnt written by you.' });
                                    }
                                });
                            }else{
                                res.status(404);
                                res.send({ msg: 'User does not have a project with that ID.' });
                            }
                        });
                    });
                });
            });
        });

        server.listen(3000);
    });
});
