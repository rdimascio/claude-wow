DROP TABLE IF EXISTS `creature_template`;
CREATE TABLE `creature_template` (
  `Entry` mediumint unsigned NOT NULL DEFAULT '0',
  `Name` char(100) NOT NULL DEFAULT '',
  `SubName` char(100) DEFAULT NULL,
  `MinLevel` tinyint unsigned NOT NULL DEFAULT '1',
  PRIMARY KEY (`Entry`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `creature_template` VALUES (7001,'Fixture Giver','Quest Clerk',5),(7002,'Fixture Wanderer',NULL,6),(7003,'[UNUSED] Old Fixture',NULL,1);
INSERT INTO `creature_template` VALUES (7004,'Fixture O\'Brien',NULL,2),(7005,'Fixture \"Twin\" Smith','',3);
DROP TABLE IF EXISTS `creature`;
CREATE TABLE `creature` (
  `guid` int unsigned NOT NULL AUTO_INCREMENT,
  `id` mediumint unsigned NOT NULL DEFAULT '0',
  `map` smallint unsigned NOT NULL DEFAULT '0',
  `spawnMask` tinyint unsigned NOT NULL DEFAULT '1',
  `position_x` float NOT NULL DEFAULT '0',
  `position_y` float NOT NULL DEFAULT '0',
  `position_z` float NOT NULL DEFAULT '0',
  PRIMARY KEY (`guid`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `creature` VALUES (1,7001,1,1,500,500,0),(2,0,1,1,-500,-500,0),(3,7002,1,1,600,600,0),(4,7001,33,1,1,1,0);
DROP TABLE IF EXISTS `creature_spawn_entry`;
CREATE TABLE `creature_spawn_entry` (
  `guid` int unsigned NOT NULL DEFAULT '0',
  `entry` mediumint unsigned NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `creature_spawn_entry` VALUES (2,7002),(2,7004);
DROP TABLE IF EXISTS `game_event_creature`;
CREATE TABLE `game_event_creature` (
  `guid` int unsigned NOT NULL,
  `event` smallint NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `game_event_creature` VALUES (3,5),(1,-2);
DROP TABLE IF EXISTS `quest_template`;
CREATE TABLE `quest_template` (
  `entry` mediumint unsigned NOT NULL DEFAULT '0',
  `MinLevel` tinyint unsigned NOT NULL DEFAULT '0',
  `Title` text,
  `Objectives` text
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `quest_template` VALUES (111,1,'Fixture Errand','Do it, then come back.'),(222,1,'Fixture Errand','The other side\'s errand.'),(333,1,'<UNUSED> Fixture',NULL);
DROP TABLE IF EXISTS `creature_questrelation`;
CREATE TABLE `creature_questrelation` (
  `id` mediumint unsigned NOT NULL DEFAULT '0',
  `quest` mediumint unsigned NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `creature_questrelation` VALUES (7001,111),(7003,333),(7002,222);
DROP TABLE IF EXISTS `creature_involvedrelation`;
CREATE TABLE `creature_involvedrelation` (
  `id` mediumint unsigned NOT NULL DEFAULT '0',
  `quest` mediumint unsigned NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `creature_involvedrelation` VALUES (7001,111);
DROP TABLE IF EXISTS `gameobject_template`;
CREATE TABLE `gameobject_template` (
  `entry` mediumint unsigned NOT NULL DEFAULT '0',
  `name` varchar(100) NOT NULL DEFAULT ''
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `gameobject_template` VALUES (8001,'Fixture Poster'),(8002,'Fixture Rock');
DROP TABLE IF EXISTS `gameobject`;
CREATE TABLE `gameobject` (
  `guid` int unsigned NOT NULL AUTO_INCREMENT,
  `id` mediumint unsigned NOT NULL DEFAULT '0',
  `map` smallint unsigned NOT NULL DEFAULT '0',
  `spawnMask` tinyint unsigned NOT NULL DEFAULT '1',
  `position_x` float NOT NULL DEFAULT '0',
  `position_y` float NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `gameobject` VALUES (10,8001,1,1,100,100),(11,8002,1,1,1,1);
DROP TABLE IF EXISTS `game_event_gameobject`;
CREATE TABLE `game_event_gameobject` (
  `guid` int unsigned NOT NULL,
  `event` smallint NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
DROP TABLE IF EXISTS `gameobject_questrelation`;
CREATE TABLE `gameobject_questrelation` (
  `id` mediumint unsigned NOT NULL DEFAULT '0',
  `quest` mediumint unsigned NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
INSERT INTO `gameobject_questrelation` VALUES (8001,222);
DROP TABLE IF EXISTS `gameobject_involvedrelation`;
CREATE TABLE `gameobject_involvedrelation` (
  `id` mediumint unsigned NOT NULL DEFAULT '0',
  `quest` mediumint unsigned NOT NULL DEFAULT '0'
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3;
