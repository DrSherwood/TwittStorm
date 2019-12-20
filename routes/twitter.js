// jshint esversion: 8
// jshint node: true
// jshint maxerr: 1000

"use strict";  // JavaScript code is executed in "strict mode"

/**
 * @desc TwittStorm, Geosoftware 2, WiSe 2019/2020
 * @author Jonathan Bahlmann, Katharina Poppinga, Benjamin Rieke, Paula Scharf
 */


var express = require('express');
var router = express.Router();
//var app = require('../app.js');

const {promiseToGetItems,promiseToPostItems} = require('./dataPromisesHelpers.js');
const {makeCircle} = require('./geometryHelpers.js');
var turf = require('@turf/turf');


var Twitter = require('twitter');

// yaml configuration
const fs = require('fs');
const yaml = require('js-yaml');
const config = yaml.safeLoad(fs.readFileSync('config.yaml', 'utf8'));

var client = new Twitter({
	consumer_key: config.keys.twitter.consumer_key,
	consumer_secret: config.keys.twitter.consumer_secret,
	access_token_key: config.keys.twitter.access_token_key,
	access_token_secret: config.keys.twitter.access_token_secret
});


/**
 * Calculates the smallest enclosing circle around an array of coordinates.
 * @author Paula Scharf, matr.: 450334
 * @param {Array} coordinatesAsArrays
 * @returns {object} enclosing - circle object of the form: {x: longitude, y: latitude, r: radius in degree}
 */
function calculateEnclosingCircle(coordinatesAsArrays) {
	let coordinatesAsObjects = [];
	coordinatesAsArrays.forEach(function (item) {
		let coordinateObject = {
			x: item[0],
			y: item[1]
		};
		coordinatesAsObjects.push(coordinateObject);
	});
	let enclosing = makeCircle(coordinatesAsObjects);
	// convert the radius from degrees to kilometers (or: transform the ellipse into a circle)
	// the maximum amount of kilometers a degree can be in germany is 111.32318 km
	// the maximum is reached at the northern extent of germany (at latitude: 54.983104153)
	enclosing.r = enclosing.r * 111.32318;
	return enclosing;
}

/**
 *
 * @author Paula Scharf, matr.: 450334
 * @param params
 * @returns {Promise<any>}
 */
var promiseToGetTweetsFromTwitter = function(params) {
	return new Promise((resolve, reject) => {
		client.get('search/tweets', params, function (error, tweets, response) {
			if (!error) {
				// send the result to the ajax request
				resolve(JSON.parse(response.body));
			} else {
				reject(error);
			}
		});
	});
};

/**
 * Checks if there are already tweets for a certain unwetter at a certain time inside the database.
 * @author Paula Scharf
 * @param dwd_id
 * @param currentTime
 */
function checkForExistingTweets(dwd_id, currentTime, db) {
	//
	return new Promise((resolve, reject) => {
			// JSON with the ID of the current Unwetter, needed for following database-check
			let query = {
				type: "Tweet",
				event_ID: dwd_id,
				$and: [
					{"requestTime": {"$gt": (currentTime - 299000)}},
					{"requestTime": {"$lt": (currentTime + 299000)}}
				]
			};
		promiseToGetItems(query, db)
				.catch(function (error) {
					reject(error);
				})
				.then(function (result) {
					if (result && result.length > 0) {
						resolve(true);
					} else {
						resolve(false);
					}
				});
	});
}

/**
 * Makes a request for new tweets to twitter and saves them in the database.
 * @author Paula Scharf, matr.: 450334
 * @param {object} twitterSearchQuery
 * @param {string} unwetterID
 * @param {string} unwetterEvent
 * @param currentTime
 * @returns {Promise<any>}
 */
var searchTweetsForEvent = function(req, res) {
	checkForExistingTweets(req.body.eventID, req.body.currentTimestamp, req.db)
		.catch(console.error)
		.then( function (response) {
			if (!response) {
				let arrayOfTweets = [];
				let searchTerm = "";
				req.body.twitterSearchQuery.searchWords.forEach(function (item) {
					searchTerm += item + " OR ";
				});
				searchTerm = searchTerm.substring(0,searchTerm.length - 4);
				let arrayOfAllCoordinates = [];
				req.body.twitterSearchQuery.geometry.coordinates.forEach(function (feature) {
					feature.forEach(function (item) {
						arrayOfAllCoordinates = arrayOfAllCoordinates.concat(item);
					})
				});
				let enclosingCircle = calculateEnclosingCircle(arrayOfAllCoordinates);
				/* this could be used to make a bbox out of the coordinates instead of the enclosing circle:
				let multilineString = turf.multilinestring(twitterSearchQuery.geometry[0].coordinates[0]);
				let bbox = turf.bbox(multiLineString);
				*/
				let enclosingCircleAsString = "" + (Math.ceil(enclosingCircle.y * 10000000) / 10000000)
					+ "," + (Math.ceil(enclosingCircle.x * 10000000) / 10000000)
					+ "," + Math.ceil(enclosingCircle.r) + "km";
				let searchQuery = {
					q: searchTerm,
					geocode: enclosingCircleAsString,
					result_type: "recent",
					count: 20
				};

				promiseToGetTweetsFromTwitter(searchQuery)
					.catch(console.error)
					.then( function (tweets) {
						if (tweets) {
							let arrayOfPolygons = [];
							req.body.twitterSearchQuery.geometry.coordinates.forEach(function (item) {
								arrayOfPolygons.push(item[0])
							});
							let polygon = turf.polygon(arrayOfPolygons);
							for (let i = tweets.statuses.length - 1; i >= 0; i--) {
								let currentFeature = tweets.statuses[i];
								let max_age = 0;
								if (config.max_age_tweets !== null) {
									max_age = currentTime - (config.max_age_tweets * 60000);
								}
								let age_tweet = Date.parse(currentFeature.created_at);
								if (currentFeature.coordinates && age_tweet >= max_age) {
									let tweetLocation = turf.point(currentFeature.coordinates.coordinates);
									if (turf.booleanPointInPolygon(tweetLocation, polygon)) {
										let currentStatus = {
											type: "Tweet",
											id: currentFeature.id,
											idstr: currentFeature.id_str,
											statusmessage: currentFeature.text,
											author: {
												id: currentFeature.user.id,
												name: currentFeature.user.name,
												location_home: currentFeature.user.location
											},
											timestamp: currentFeature.created_at,
											location_actual: currentFeature.coordinates,
											event_ID: req.body.eventID,
											requestTime: req.body.currentTimestamp
										};
										arrayOfTweets.push(currentStatus);
									}
								}
							}
						}
						try {
							if (arrayOfTweets.length === 0) {
								let emptyTweet = {
									type: "Tweet",
									event_ID: req.body.eventID,
									requestTime: req.body.currentTimestamp
								};
								arrayOfTweets.push(emptyTweet);
							}
							promiseToPostItems(arrayOfTweets,req.db)
								.catch(console.error)
								.then( function () {
									let query = {type: "Tweet", event_ID: req.body.eventID};
									promiseToGetItems(query,req.db)
										.catch(console.error)
										.then( function (response) {
											res.send(response);
										});
								});
						} catch (e) {
							console.dir(e);
							res.status(500).send(e);
						}
					});
			} else {
				let query = {type: "Tweet", event_ID: req.body.eventID};
				promiseToGetItems(query,req.db)
					.catch(console.error)
					.then( function (response) {
						res.send(response);
					});

			}
		}, function(error) {
			console.dir(error);
			res.status(500).send(error);
		});
};

router.route("/tweets").post(searchTweetsForEvent);

module.exports = router;
